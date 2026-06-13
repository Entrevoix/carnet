/**
 * RN-side notification for the editor's content-applied ack. The web side replies
 * with a `content-ack` (carrying the applied markdown length) right after it runs
 * setContent for a set-markdown message. WysiwygEditor awaits this to confirm the
 * body REALLY landed in the editor — not merely that setMarkdown was fired — before
 * it both (a) starts swapping images in and (b) will read the body back on save.
 * That closes the issue-#43 hole where an oversized injection silently failed to
 * apply and a Save then blanked the note.
 *
 * Mirrors markdownResponse.ts's single-slot resolver pattern: one injection is in
 * flight at a time, so one pending handler suffices. Re-sends of the idempotent
 * setMarkdown staircase each produce an ack; the FIRST clears the slot and the rest
 * are no-ops, so the component acts on the ack exactly once.
 */
let pendingAck: ((length: number) => void) | null = null;

/**
 * Register a one-shot handler for the next content-ack. Returns a disposer that
 * clears the slot (call it from a fallback timer so a never-arriving ack can't
 * leave the handler — or a late resolve — dangling, and on unmount).
 */
export function onceContentAck(handler: (length: number) => void): () => void {
  pendingAck = handler;
  return () => {
    if (pendingAck === handler) pendingAck = null;
  };
}

/** Fire the registered content-ack handler with the applied length, then clear the
 * slot (no-op if none pending or already fired). */
export function resolveContentAck(length: number): void {
  const handler = pendingAck;
  pendingAck = null;
  handler?.(length);
}
