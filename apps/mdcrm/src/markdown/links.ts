import type { AnyRecord } from "../models/records.js";

/** Machine-readable references only. Wiki links are presentation, never identity. */
export function recordReferences(record: AnyRecord): string[] {
  const references: string[] = [];
  switch (record.type) {
    case "capture": if (record.event_context?.event_id) references.push(record.event_context.event_id); break;
    case "contact":
      if (record.organization?.id) references.push(record.organization.id);
      references.push(...record.source_capture_ids);
      if (record.canonical_contact_id) references.push(record.canonical_contact_id);
      break;
    case "organization": references.push(...record.source_capture_ids, ...(record.contact_ids ?? [])); break;
    case "event": references.push(...record.contact_ids, ...record.capture_ids); break;
    case "interaction": references.push(...record.contact_ids, ...record.organization_ids, ...record.source_capture_ids); if (record.event_id) references.push(record.event_id); break;
    case "task": references.push(...record.source_capture_ids, ...(record.contact_ids ?? [])); break;
    case "review_item": references.push(record.source_capture_id, ...(record.candidate_contact_ids ?? [])); if (record.recommended_contact_id) references.push(record.recommended_contact_id); break;
    case "processing_job": references.push(record.capture_id); break;
    case "proposed_change": references.push(record.target_id); break;
  }
  return [...new Set(references)];
}
