import { describe, expect, it } from "vitest";
import { assertProcessingStateTransition, canTransitionProcessingState } from "./stateMachine.js";

describe("processing state transitions", () => {
  it("allows retries and review resumption", () => {
    expect(canTransitionProcessingState("failed", "queued")).toBe(true);
    expect(canTransitionProcessingState("review_required", "processing")).toBe(true);
  });
  it("rejects impossible backwards transitions", () => {
    expect(() => assertProcessingStateTransition("completed", "captured")).toThrow("completed -> captured");
  });
});
