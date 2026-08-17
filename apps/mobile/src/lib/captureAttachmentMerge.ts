/**
 * Attachment-ref reconciliation for CaptureScreen's Idea resubmit path.
 *
 * Owns the one invariant this module exists to enforce: `persistAttachments`
 * memoizes by `PickedAttachment` object identity, so an attachment staged
 * before an Edit tap can come back in BOTH the preserved-from-the-first-
 * attempt list and the fresh-from-this-attempt list — merging them naively
 * would embed it twice. Split out of CaptureScreen.tsx as a move-only
 * extraction so the merge/de-dupe logic is unit-testable without a renderer.
 */

import type { AttachmentRef } from "./writer";

/**
 * Merge this submit's newly-persisted attachment refs with any preserved from
 * an earlier attempt in the same capture (Edit tapped mid-enrichment already
 * wrote its attachments to disk; `pending` was cleared the moment the raw
 * note landed, so a resubmit's own persist call returns nothing for them).
 *
 * On a fresh (non-resuming) submit there is nothing preserved, so this is
 * just `refs`. On a resume, de-dupe by `rel`: `persistAttachments` memoizes
 * by `PickedAttachment` identity, so an attachment still staged when Edit was
 * tapped comes back in BOTH lists, and embedding it twice would double the
 * markdown reference.
 */
export function mergeAttachmentRefs(
  preserved: readonly AttachmentRef[],
  refs: readonly AttachmentRef[],
  resuming: boolean,
): AttachmentRef[] {
  if (!resuming) return [...refs];
  return [...new Map([...preserved, ...refs].map((r) => [r.rel, r])).values()];
}
