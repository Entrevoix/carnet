// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * mtime-guarded in-place enrichment for Person notes.
 *
 * Idea has had this since save-first (ideaSaveFirst.ts's applyEnrichedIdea /
 * enrichIdeaInPlace pair); Person never did. Its only writer is `writePerson`,
 * which always creates a fresh collision-suffixed file and carries no mtime
 * conflict guard. Re-enriching an existing note needs exactly that, so it is
 * built here from `updateNoteIfUnchanged` directly.
 *
 * Journal is deliberately absent. A Journal day file holds MANY entries under
 * `## HH:MM` headings, so "re-enrich this file" would collapse a whole day into
 * one enrichment of the concatenated text and destroy that structure. Journal
 * re-enrichment needs to be entry-scoped, which is a different operation than
 * this whole-file overwrite — see finishEnrichment.ts's isReEnrichableMode.
 */

import { enrichPerson, isNotConfiguredError, isPermanentError } from "./dispatcher";
import { upsertFrontmatterField } from "./frontmatter";
import { mergeUserTags } from "./tags";
import { injectAttachments, updateNoteIfUnchanged, type AttachmentRef } from "./writer";

/**
 * Outcome of an in-place Person enrichment. Same shape and same `kind`
 * discriminant as EnrichIdeaOutcome so every caller handles both alike.
 */
export type EnrichInPlaceOutcome =
  | { kind: "updated"; markdown: string }
  | { kind: "conflict" }
  | { kind: "failed"; transient: boolean; reason: string };

export interface EnrichPersonInPlaceInput {
  filepath: string;
  /** Baseline read BEFORE the model call — see finishEnrichment.ts. */
  expectedMtime: number | null;
  /** The note's content at that same moment. Carries the conflict guard on SAF
   * vaults, which report no mtime — see writer.ts's updateNoteIfUnchanged. */
  expectedContent?: string | null;
  ocrResult: string;
  context: string;
  /** Re-merged onto the model's output, which knows nothing about them. */
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * Re-enrich a Person note, overwriting the given file in place.
 *
 * The model returns its own frontmatter and body with no knowledge of what the
 * user filed the note under, so the tags/location/attachments carried by the
 * existing note are merged back on before the write — the same pipeline, in the
 * same order, as applyEnrichedIdea and captureConfirmSave's composeMarkdown.
 * Skipping it silently drops the user's filing metadata on every re-enrich.
 */
export async function enrichPersonInPlace(
  input: EnrichPersonInPlaceInput,
): Promise<EnrichInPlaceOutcome> {
  let enriched: string;
  try {
    const result = await enrichPerson({
      ocrResult: input.ocrResult,
      context: input.context,
    });
    enriched = result.markdown;
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    // Not-configured + 4xx are permanent (no retry helps); everything else
    // (network / timeout / 5xx) is transient and safe to queue for a drain.
    const transient = !isNotConfiguredError(e) && !isPermanentError(e);
    return { kind: "failed", transient, reason };
  }

  let md = injectAttachments(enriched, input.attachments ?? []);
  md = mergeUserTags(md, input.tags);
  if (input.location) md = upsertFrontmatterField(md, "location", input.location);

  const { ok } = await updateNoteIfUnchanged(
    input.filepath,
    md,
    input.expectedMtime,
    input.expectedContent,
  );
  return ok ? { kind: "updated", markdown: md } : { kind: "conflict" };
}
