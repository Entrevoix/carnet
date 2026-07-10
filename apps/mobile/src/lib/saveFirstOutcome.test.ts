import { describe, expect, it } from "vitest";

import {
  planSaveFirstOutcome,
  SAVE_FIRST_CONFLICT_NOTICE,
  SAVE_FIRST_QUEUED_NOTICE,
  SAVE_FIRST_QUEUE_FAILED_NOTICE,
} from "./saveFirstOutcome";

describe("planSaveFirstOutcome", () => {
  it("closes on a successful enrichment, carrying the final markdown for the index", () => {
    const plan = planSaveFirstOutcome({ kind: "updated", markdown: "# Enriched\n" });
    expect(plan).toEqual({ kind: "close", markdown: "# Enriched\n" });
  });

  it("surfaces a conflict notice and stays put when the note changed on disk", () => {
    const plan = planSaveFirstOutcome({ kind: "conflict" });
    expect(plan).toEqual({ kind: "conflict", notice: SAVE_FIRST_CONFLICT_NOTICE });
  });

  it("plans a queue (with success + fallback copy) for a transient failure", () => {
    const plan = planSaveFirstOutcome({
      kind: "failed",
      transient: true,
      reason: "network down",
    });
    expect(plan).toEqual({
      kind: "queue",
      notice: SAVE_FIRST_QUEUED_NOTICE,
      fallbackNotice: SAVE_FIRST_QUEUE_FAILED_NOTICE,
    });
  });

  it("plans the degraded banner (keeping the raw note) for a permanent failure", () => {
    const plan = planSaveFirstOutcome({
      kind: "failed",
      transient: false,
      reason: "model exploded",
    });
    expect(plan).toEqual({ kind: "degraded", reason: "model exploded" });
  });
});
