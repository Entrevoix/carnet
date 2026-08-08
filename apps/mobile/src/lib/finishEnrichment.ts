// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finish the enrichment of a save-first Idea that never got enriched.
 *
 * A capture made while the provider is unreachable is written raw and queued
 * (`status: pending-enrich`). Normally the queue drains and overwrites the note
 * with the enriched version. But `queue.ts`'s drain deliberately treats a
 * conflicted write as processed — "a skipped write still counts as processed;
 * the raw note stays and the user's edit wins" — and then removes the row. So
 * if the file changed during the queue window (a WYSIWYG edit, a Syncthing
 * write from the workstation, or an Enhance run, which guarantees it), the
 * enrichment is computed, discarded, and the row is gone.
 *
 * The note is then stuck: no title, no tags, a permanent `pending` chip, and
 * nothing left to retry it. `noteReprocess.reEnrichNote` cannot help — it
 * requires a paired image on disk and is gated to photo/shared-image notes, so
 * a text Idea (exactly what queues offline) has no path at all.
 *
 * This is that path. It is user-initiated, never automatic: the drain already
 * decided not to overwrite, and re-deciding that on the user's behalf is the
 * clobber this codebase guards against everywhere else.
 */

import { getFrontmatterTags, extractFrontmatterField, stripFrontmatter } from "./frontmatter";
import { enrichIdeaInPlace, PENDING_ENRICH_STATUS } from "./ideaSaveFirst";
import { getModificationTime, readNote } from "./writer";

/**
 * Outcome of finishing a stalled enrichment. Mirrors `EnhanceProseOutcome` and
 * `ReprocessOutcome` — same shape, so the screen handles all three alike.
 */
export type FinishEnrichmentOutcome =
  | { kind: "updated"; markdown: string }
  | { kind: "failed"; reason: string };

/** True when this note is a raw save-first capture still awaiting enrichment. */
export function isPendingEnrich(body: string): boolean {
  return extractFrontmatterField(body, "status") === PENDING_ENRICH_STATUS;
}

/**
 * Run the enrichment this note never received, in place.
 *
 * Reads the CURRENT file rather than trusting the caller's snapshot, and takes
 * the mtime baseline BEFORE the model call — the ordering `enhanceProse.ts` and
 * `promoteIdeaOnDisk.ts` both use, because the call is a wide window for a
 * synced edit to land. Never throws; every failure returns a reason.
 */
export async function finishPendingEnrichment(input: {
  body: string;
  filepath: string;
}): Promise<FinishEnrichmentOutcome> {
  try {
    // Baseline first — a baseline read after the call would match whatever the
    // edit produced, making the guard useless for the window it exists to cover.
    const baseline = await getModificationTime(input.filepath);

    let source = input.body;
    try {
      source = await readNote(input.filepath);
    } catch {
      // Unreadable: fall back to the caller's snapshot rather than refusing.
      // The mtime guard still protects the write.
    }

    if (!isPendingEnrich(source)) {
      return {
        kind: "failed",
        reason: "This note is not awaiting enrichment.",
      };
    }

    // The raw note's body IS the user's original text — buildRawIdeaMarkdown
    // writes it verbatim beneath the frontmatter, so no reconstruction is
    // needed. Tags and location the user set at capture are preserved and
    // re-merged by applyEnrichedIdea.
    const text = stripFrontmatter(source).trim();
    if (!text) {
      return { kind: "failed", reason: "This note has no text to enrich." };
    }
    const location = extractFrontmatterField(source, "location") ?? undefined;

    const outcome = await enrichIdeaInPlace({
      filepath: input.filepath,
      expectedMtime: baseline,
      text,
      tags: getFrontmatterTags(source),
      location,
    });

    if (outcome.kind === "updated") {
      return { kind: "updated", markdown: outcome.markdown };
    }
    if (outcome.kind === "conflict") {
      return {
        kind: "failed",
        reason:
          "This note changed while enrichment was running, so your version was kept. Try again.",
      };
    }
    return { kind: "failed", reason: outcome.reason };
  } catch (e: unknown) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
