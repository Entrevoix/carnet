import type { MatchCandidate } from "../matching/contactMatcher.js";
import type { ReviewItemRecord } from "../models/records.js";
import { createId } from "../models/ids.js";

export function possibleDuplicateReview(
  captureId: string,
  candidates: readonly MatchCandidate[],
  now = new Date(),
  id = createId("review_item", now.getTime()),
): ReviewItemRecord {
  const top = candidates[0];
  return {
    schema_version: 1, type: "review_item", id,
    review_type: "possible_duplicate", state: "open", priority: "normal",
    source_capture_id: captureId,
    candidate_contact_ids: candidates.map((candidate) => candidate.contact.id),
    ...(top ? { recommended_contact_id: top.contact.id, confidence: Math.min(0.99, Math.max(0, top.score / 100)), evidence: top.evidence } : {}),
    created_at: now.toISOString(), updated_at: now.toISOString(),
    provenance: [{ source_type: "capture", source_id: captureId, extraction_method: "deterministic_matching", processor: "capture-pipeline", processor_version: "1.0.0", created_at: now.toISOString() }],
  };
}
