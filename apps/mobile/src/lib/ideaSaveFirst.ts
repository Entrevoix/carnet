/**
 * Save-first Idea capture (Stage 2 / branch B4).
 *
 * The default Idea flow no longer blocks on the LLM before anything is written.
 * On Save, a deterministic client-side raw note lands on disk immediately
 * (status `pending-enrich`), and enrichment runs afterwards, updating the SAME
 * file in place — never renaming it (a rename is delete+create, which doubles
 * Syncthing churn and reopens collision handling). The in-place overwrite is
 * guarded by the writer.ts mtime check so a user/synced edit inside the enrich
 * window is kept instead of clobbered.
 *
 * Journal and Person are intentionally NOT routed through this module: Journal
 * keeps its deferred-write model and Person keeps enrich-then-preview. Only Idea
 * is save-first, and only when Settings.previewBeforeSave is off (the default).
 *
 * The pure builders (deriveRawIdeaSlug, buildRawIdeaMarkdown) plus the IO
 * functions (writeRawIdea, applyEnrichedIdea, enrichIdeaInPlace) are kept here,
 * out of the React screen, so the timing- and conflict-sensitive logic is unit
 * testable without a renderer.
 */

import {
  getModificationTime,
  injectAttachments,
  slugify,
  updateNoteIfUnchanged,
  writeIdea,
  type AttachmentRef,
} from "./writer";
import { upsertFrontmatterField } from "./frontmatter";
import { mergeUserTags } from "./tags";
import { enrichIdea, isNotConfiguredError, isPermanentError } from "./dispatcher";

/** Frontmatter `status` value stamped on the raw note before enrichment lands.
 * Enrichment overwrites the whole note (including this) with the LLM result. */
export const PENDING_ENRICH_STATUS = "pending-enrich";

/** The captured inputs a save-first Idea needs. Attachments are the post-write
 * rel-path references (binaries already on disk), matching the online + offline
 * paths so all three inject identically. */
export interface RawIdeaInput {
  /** The user's raw idea text — becomes the note body verbatim. */
  text: string;
  /** User-entered tags, merged into the frontmatter deterministically. */
  tags: string[];
  /** User-selected `lat,lon`, injected into frontmatter when set. */
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * Decide whether Idea capture uses the save-first path. Save-first is the
 * default; `previewBeforeSave` (a Settings flag) restores the old blocking
 * enrich → preview → Save flow. Journal and Person never call this.
 */
export function usesSaveFirst(previewBeforeSave: boolean): boolean {
  return !previewBeforeSave;
}

/**
 * Derive the on-disk slug for a save-first Idea from the RAW text. The polished
 * LLM title doesn't exist yet at write time, and the file is deliberately not
 * renamed on enrichment, so the slug reflects the raw text — the accepted price
 * of save-first (see the decision memo). Falls back to "idea" when the text
 * slugifies to nothing (e.g. emoji-only input).
 */
export function deriveRawIdeaSlug(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return slugify(firstLine.slice(0, 80)) || "idea";
}

/**
 * Build the deterministic client-side markdown written immediately on Save,
 * before any enrichment. Frontmatter carries `created` (ISO) and
 * `status: pending-enrich`; the body is the user's raw text verbatim. User tags
 * and location are injected the same way the enriched paths do, and attachments
 * are folded in so the transient note already references its binaries.
 *
 * Pure — pass `now` for deterministic output in tests.
 */
export function buildRawIdeaMarkdown(input: RawIdeaInput, now: Date = new Date()): string {
  const body = input.text.trim();
  let md = `---\ncreated: ${now.toISOString()}\nstatus: ${PENDING_ENRICH_STATUS}\n---\n${body}\n`;
  // Order matches confirmSave: attachments first (so the tag/location merges see
  // the final body), then user tags, then location.
  md = injectAttachments(md, input.attachments ?? []);
  md = mergeUserTags(md, input.tags);
  if (input.location) md = upsertFrontmatterField(md, "location", input.location);
  return md;
}

export interface WriteRawIdeaResult {
  filepath: string;
  slug: string;
  /** mtime captured right after the raw write — the conflict-guard baseline for
   * the enriched overwrite. null when the backend can't report one (SAF). */
  mtime: number | null;
}

/**
 * Write the raw Idea note to disk immediately and return its path plus the
 * mtime baseline for the guarded enriched overwrite. This is the save-first
 * write: it completes before enrichment is even attempted.
 */
export async function writeRawIdea(
  input: RawIdeaInput,
  now?: Date,
): Promise<WriteRawIdeaResult> {
  const slug = deriveRawIdeaSlug(input.text);
  const markdown = buildRawIdeaMarkdown(input, now);
  const { filepath } = await writeIdea(slug, markdown);
  const mtime = await getModificationTime(filepath);
  return { filepath, slug, mtime };
}

export interface ApplyEnrichedIdeaInput {
  filepath: string;
  /** mtime baseline from writeRawIdea (or a fresh read before a manual re-enrich). */
  expectedMtime: number | null;
  /** Raw enriched markdown from enrichIdea — its own frontmatter + H1. */
  enrichedMarkdown: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * Overwrite the raw Idea note in place with the enriched result, preserving the
 * user's tags/location and keeping the exact same filename (no rename). Guarded
 * by the mtime check: if the file changed under us (a user edit or a synced
 * workstation edit), the enriched write is skipped and the user's version is
 * kept — `status: "conflict"`.
 */
export async function applyEnrichedIdea(
  input: ApplyEnrichedIdeaInput,
): Promise<{ status: "updated" | "conflict" }> {
  let md = injectAttachments(input.enrichedMarkdown, input.attachments ?? []);
  md = mergeUserTags(md, input.tags);
  if (input.location) md = upsertFrontmatterField(md, "location", input.location);
  const result = await updateNoteIfUnchanged(input.filepath, md, input.expectedMtime);
  return { status: result.ok ? "updated" : "conflict" };
}

/** Everything enrichIdeaInPlace needs — the raw text plus the target file the
 * raw write already produced. */
export interface EnrichIdeaInPlaceInput {
  filepath: string;
  expectedMtime: number | null;
  text: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * Outcome of the async enrichment that follows a save-first raw write.
 *   - updated:  enrichment succeeded and the note was overwritten in place.
 *   - conflict: the note changed during enrichment — the user's version is kept.
 *   - failed:   enrichment threw. `transient` distinguishes a network/5xx blip
 *               (caller should enqueue for a later drain) from a permanent 4xx /
 *               not-configured failure (caller keeps the raw note + shows the
 *               degraded banner). Either way the raw note is safe on disk.
 */
export type EnrichIdeaOutcome =
  | { kind: "updated" }
  | { kind: "conflict" }
  | { kind: "failed"; transient: boolean; reason: string };

/**
 * Enrich a save-first Idea and update its file in place. The raw note already
 * exists on disk (writeRawIdea ran first), so any failure here is recoverable:
 * the raw note stays, and the outcome tells the caller how to surface it.
 */
export async function enrichIdeaInPlace(
  input: EnrichIdeaInPlaceInput,
): Promise<EnrichIdeaOutcome> {
  let enriched: string;
  try {
    const result = await enrichIdea(input.text);
    enriched = result.markdown;
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    // Not-configured + 4xx are permanent (no retry helps); everything else
    // (network / timeout / 5xx) is transient and safe to queue for a drain.
    const transient = !isNotConfiguredError(e) && !isPermanentError(e);
    return { kind: "failed", transient, reason };
  }
  const applied = await applyEnrichedIdea({
    filepath: input.filepath,
    expectedMtime: input.expectedMtime,
    enrichedMarkdown: enriched,
    tags: input.tags,
    location: input.location,
    attachments: input.attachments,
  });
  return applied.status === "updated" ? { kind: "updated" } : { kind: "conflict" };
}
