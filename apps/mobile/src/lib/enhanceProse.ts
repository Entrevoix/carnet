// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enhance a saved note's prose in place — rewrite the body with a (typically
 * stronger) model, leaving everything structural alone.
 *
 * Mirrors lib/noteReprocess.ts — same outcome union, same "call, splice,
 * updateNote" spine — but deliberately lives beside it rather than inside it:
 * that module scopes itself to re-running against a note's PAIRED BINARY, and
 * both its functions begin by locating one. Enhance has no binary, which is
 * exactly why it works on a text-only journal entry.
 *
 * Frontmatter and the leading `# Title` are split off BEFORE the call and
 * re-attached after, so the model never sees or rewrites them. That is what
 * keeps the byte-compatible-frontmatter constraint intact.
 */

import { enhanceProse as dispatchEnhance, FALLBACK_PROVIDER_FIELD } from "./dispatcher";
import { splitFrontmatter, upsertFrontmatterField } from "./frontmatter";
import { updateNote } from "./writer";

/** Frontmatter field stamped on a note whose prose has been enhanced. Its
 * presence is the only on-disk signal that a body is machine-polished — the
 * original wording is not recoverable from the note itself. */
export const ENHANCED_FIELD = "enhanced";

/**
 * Below this many characters of prose there is nothing worth spending a model
 * call on, and an near-empty body is the case most likely to make a model
 * invent content to fill the space — the one failure this prompt must never
 * have. Rejected before the call, not after.
 */
const MIN_PROSE_CHARS = 40;

/**
 * Outcome of an enhance attempt:
 *   - updated: the note was rewritten in place; `nextBody` is the new content.
 *   - failed:  nothing was written; `reason` is the user-facing message.
 */
export type EnhanceProseOutcome =
  | { kind: "updated"; nextBody: string; providerLabel: string }
  | { kind: "failed"; reason: string };

/** Local-date YYYY-MM-DD. toISOString() would return UTC and shift a
 * late-evening enhance (e.g. 11pm in UTC-8) onto the next day — the same trap
 * prompts.ts documents for capture dates. */
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Split a body into its leading `# Title` line (with the blank lines that
 * follow it) and the prose beneath. `title` is "" when the body has no
 * leading H1, in which case the whole body is prose.
 *
 * Only a top-level `# ` heading counts: `##` and deeper are section headings
 * that belong to the prose and must be handed to the model with it. Hence the
 * mandatory space/tab after the hash — it is what makes `##` fall through.
 */
export function splitLeadingTitle(body: string): { title: string; prose: string } {
  const match = body.match(/^(#[ \t][^\n]*\n+)([\s\S]*)$/);
  return match ? { title: match[1], prose: match[2] } : { title: "", prose: body };
}

/**
 * Stamp provenance onto a note that already carries frontmatter.
 *
 * Only stamps when a frontmatter block is present: upsertFrontmatterField
 * CREATES one when absent, and silently growing a `---` block onto a note that
 * never had one would be a structural change to a file this feature promises
 * only to reword.
 */
function stampProvenance(
  markdown: string,
  outcome: { usedFallback: boolean; fallbackProviderId: string | null },
): string {
  const { header } = splitFrontmatter(markdown);
  if (!header) return markdown;
  const stamped = upsertFrontmatterField(markdown, ENHANCED_FIELD, todayLocal());
  if (!outcome.usedFallback || !outcome.fallbackProviderId) return stamped;
  return upsertFrontmatterField(stamped, FALLBACK_PROVIDER_FIELD, outcome.fallbackProviderId);
}

/**
 * Rewrite `input.body`'s prose and persist it to `input.filepath`.
 *
 * Never throws — every failure path (too short, empty model response, network
 * error, write error) returns a `failed` outcome and leaves the note on disk
 * exactly as it was.
 */
export async function enhanceNoteProse(input: {
  body: string;
  filepath: string;
}): Promise<EnhanceProseOutcome> {
  try {
    const { header, body } = splitFrontmatter(input.body);
    const { title, prose } = splitLeadingTitle(body);
    if (prose.trim().length < MIN_PROSE_CHARS) {
      throw new Error("This note is too short to enhance — add some prose first.");
    }

    const outcome = await dispatchEnhance(prose);
    // Already fence-stripped AND security-sanitized upstream: executeChat runs
    // stripCodeFences, then sanitizeAndNormalize(...) ?? sanitizeMarkdown(...),
    // and prose-only output falls through to the latter because
    // normalizeFrontmatter bails on a missing header. Re-sanitizing here would
    // be redundant, and reaching for sanitizeMarkdown to strip fences would be
    // wrong — it preserves fence bodies verbatim by design.
    const cleaned = outcome.result.markdown.trim();
    if (!cleaned) {
      throw new Error("The model returned nothing — the note was left unchanged.");
    }

    // header already carries its own trailing newline (see splitFrontmatter),
    // as does title, so neither needs a separator added here.
    const next = stampProvenance(`${header}${title}${cleaned}\n`, outcome);
    await updateNote(input.filepath, next);
    return { kind: "updated", nextBody: next, providerLabel: outcome.providerLabel };
  } catch (err: unknown) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : "Enhance failed.",
    };
  }
}
