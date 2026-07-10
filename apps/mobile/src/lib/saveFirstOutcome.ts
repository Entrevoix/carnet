/**
 * Save-first enrichment → UI plan (extracted from CaptureScreen).
 *
 * After a save-first Idea's raw note is on disk, enrichment runs and returns an
 * `EnrichIdeaOutcome`. This module maps that outcome onto a small, testable
 * "plan" the screen executes — centralizing the user-facing copy and the
 * branch decisions so the component only wires state/navigation/enqueue.
 *
 * The raw note is already saved in every branch, so nothing is ever lost:
 *   - close:    enrichment landed — reflect it in the index and leave the screen.
 *   - conflict: the note changed on disk mid-enrich — the user's version was kept.
 *   - queue:    a transient failure — enqueue for a later drain (notice on
 *               success, fallbackNotice if even the enqueue fails).
 *   - degraded: a permanent failure — keep the raw note and offer Re-enrich.
 *
 * Pure and React-free.
 */

import type { EnrichIdeaOutcome } from "./ideaSaveFirst";

/** Info line shown when the note changed on disk during enrichment. */
export const SAVE_FIRST_CONFLICT_NOTICE =
  "This note changed on disk during enrichment — your version was kept.";
/** Info line shown when a transient failure was successfully queued. */
export const SAVE_FIRST_QUEUED_NOTICE =
  "Saved as a raw note — enrichment queued and will finish when OmniRoute is reachable.";
/** Fallback info line when even the offline enqueue failed. */
export const SAVE_FIRST_QUEUE_FAILED_NOTICE =
  "Saved as a raw note — enrichment will retry next time you open carnet.";

/**
 * What the screen should do with a save-first enrichment outcome.
 *   - close:    `markdown` is the final on-disk content — upsert it into the
 *               note index, then navigate away.
 *   - conflict: show `notice` as an info banner; stay on the saved screen.
 *   - queue:    enqueue the capture for a later drain — show `notice` on success,
 *               `fallbackNotice` if the enqueue itself throws.
 *   - degraded: show the degraded banner with `reason` and offer Re-enrich.
 */
export type SaveFirstPlan =
  | { kind: "close"; markdown: string }
  | { kind: "conflict"; notice: string }
  | { kind: "queue"; notice: string; fallbackNotice: string }
  | { kind: "degraded"; reason: string };

/** Map an enrichment outcome onto the plan the screen should execute. */
export function planSaveFirstOutcome(outcome: EnrichIdeaOutcome): SaveFirstPlan {
  switch (outcome.kind) {
    case "updated":
      return { kind: "close", markdown: outcome.markdown };
    case "conflict":
      return { kind: "conflict", notice: SAVE_FIRST_CONFLICT_NOTICE };
    case "failed":
      return outcome.transient
        ? {
            kind: "queue",
            notice: SAVE_FIRST_QUEUED_NOTICE,
            fallbackNotice: SAVE_FIRST_QUEUE_FAILED_NOTICE,
          }
        : { kind: "degraded", reason: outcome.reason };
  }
}
