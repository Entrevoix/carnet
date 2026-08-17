// ── llmErrors.test.ts ────────────────────────────────────────────────────────
// Move-only split of llmClient.test.ts along the llmErrors.ts seam — the
// status-classification predicates that generalize over any HttpError
// subclass, not just LlmClientError. See llmClient.test.ts's header comment
// for the origin of this suite.

import { describe, expect, it } from "vitest";
import { HttpError } from "./httpClient";
import { isNotConfiguredError, isPermanentError } from "./llmErrors";

describe("isPermanentError / isNotConfiguredError generalize to HttpError", () => {
  it("classifies a non-LlmClientError HttpError subclass by its status/notConfigured fields", () => {
    class FakeBackendError extends HttpError {}
    const permanent = new FakeBackendError("bad request", 400);
    const notConfigured = new FakeBackendError("no url", 0, { notConfigured: true });
    const transient = new FakeBackendError("network blip", 0);

    expect(isPermanentError(permanent)).toBe(true);
    expect(isNotConfiguredError(notConfigured)).toBe(true);
    expect(isPermanentError(notConfigured)).toBe(false);
    expect(isPermanentError(transient)).toBe(false);
    expect(isNotConfiguredError(transient)).toBe(false);
  });
});
