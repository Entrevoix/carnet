import { describe, expect, it } from "vitest";
import { scoreContact } from "./contactMatcher.js";
import type { CaptureRecord, ContactRecord } from "../models/records.js";

const capture = { schema_version: 1, type: "capture", id: "cap_01K1V8FQ73P2N6TQ84D7KZ19BC", created_at: "2026-08-03T09:22:00.000Z", updated_at: "2026-08-03T09:22:00.000Z", captured_by: "test", capture_method: "camera", capture_kind: "business_card", processing_status: "captured", review_status: "unreviewed", attachments: [], extracted: { name: "Jane Smith", company: "Acme Industries", email: "Jane@Acme.example", phone_normalized: "+12025550142" } } satisfies CaptureRecord;
const contact = { schema_version: 1, type: "contact", id: "con_01K1V8J3Y0T4Q6E1BZ8D2R5HPA", name: { display: "Jane Smith", normalized: "jane smith" }, organization: { name: "Acme Industries" }, emails: [{ value: "jane@acme.example", normalized: "jane@acme.example", status: "observed", source_capture_id: capture.id }], phones: [{ display: "+1 202 555 0142", normalized: "+12025550142", status: "normalized", source_capture_id: capture.id }], record_status: "active", verification_status: "unverified", source_capture_ids: [capture.id] } satisfies ContactRecord;

describe("contact matching", () => {
  it("scores deterministic exact identifiers before softer evidence", () => {
    const result = scoreContact(capture, contact);
    expect(result.score).toBeGreaterThanOrEqual(255);
    expect(result.evidence).toContain("+100 exact normalized email");
    expect(result.evidence).toContain("+90 exact normalized phone");
  });
  it("penalizes conflicting identifiers", () => {
    const result = scoreContact({ ...capture, extracted: { ...capture.extracted, email: "other@example.net", phone_normalized: "+442079460958" } }, contact);
    expect(result.evidence).toContain("-60 conflicting email");
    expect(result.evidence).toContain("-50 conflicting phone");
  });
});
