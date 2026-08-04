import { describe, expect, it } from "vitest";
import { createId, isId } from "./ids.js";
import { idempotencyKey } from "../jobs/idempotency.js";
import { sanitizeFilename } from "../storage/repository.js";

describe("identity and idempotency", () => {
  it("creates prefixed sortable ULIDs", () => {
    const first = createId("capture", 1_700_000_000_000);
    const second = createId("capture", 1_700_000_000_001);
    expect(isId("capture", first)).toBe(true);
    expect(first < second).toBe(true);
  });
  it("derives stable, revision-sensitive idempotency keys", () => {
    const first = idempotencyKey("match", "1", "cap_1", "rev-a");
    expect(first).toBe(idempotencyKey("match", "1", "cap_1", "rev-a"));
    expect(first).not.toBe(idempotencyKey("match", "1", "cap_1", "rev-b"));
  });
  it("sanitizes filenames without using them as ids", () => {
    expect(sanitizeFilename("Jane Smith / Acmé Ltd.")).toBe("jane-smith-acme-ltd");
    expect(sanitizeFilename("../../")).toBe("record");
  });
});
