import type { ProcessingState } from "./records.js";

const ALLOWED: Record<ProcessingState, readonly ProcessingState[]> = {
  captured: ["normalized", "queued", "failed"],
  normalized: ["queued", "synced", "processing", "failed"],
  synced: ["queued", "processing", "failed"],
  queued: ["processing", "failed"],
  processing: ["review_required", "completed", "failed"],
  review_required: ["processing", "completed", "failed"],
  completed: ["queued", "processing"],
  failed: ["queued", "processing"],
};

export function canTransitionProcessingState(from: ProcessingState, to: ProcessingState): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export function assertProcessingStateTransition(from: ProcessingState, to: ProcessingState): void {
  if (!canTransitionProcessingState(from, to)) throw new Error(`Invalid processing transition: ${from} -> ${to}`);
}
