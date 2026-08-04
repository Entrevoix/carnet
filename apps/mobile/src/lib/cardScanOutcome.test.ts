import { beforeEach, describe, expect, it, vi } from "vitest";

// Same seam as captureErrorDecision.test.ts: ./dispatcher pulls the React
// Native module graph, so the predicates are mocked here. Their real contract
// (status 0 + `notConfigured` flag, blank vision model included) is covered
// against real LlmClientError shapes in llmClient.test.ts:211-222 and 476-490.
const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
}));

import { cardScanHint, classifyCardScanOcrError } from "./cardScanOutcome";

beforeEach(() => {
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
});

describe("classifyCardScanOcrError", () => {
  it("classifies an unconfigured provider from the typed flag, not the message text", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    const error = new Error("OmniRoute URL not configured — set it in Settings");

    expect(classifyCardScanOcrError(error)).toEqual({
      kind: "notConfigured",
      message: "OmniRoute URL not configured — set it in Settings",
    });
    expect(isNotConfiguredErrorMock).toHaveBeenCalledWith(error);
  });

  it("keeps the provider's own wording so a blank vision model stays distinguishable from a blank URL", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("Vision model not configured — set it in Settings")).message)
      .toContain("Vision model");
  });

  it("classifies a 4xx as permanent", () => {
    isPermanentErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("OmniRoute error — bad api key")).kind).toBe("permanent");
  });

  it("classifies anything unflagged as transient", () => {
    expect(classifyCardScanOcrError(new Error("OmniRoute network error — timeout")).kind).toBe("transient");
  });

  it("prefers notConfigured when an error somehow satisfies both predicates", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("ambiguous")).kind).toBe("notConfigured");
  });

  it("treats a non-Error throw as transient without crashing", () => {
    expect(classifyCardScanOcrError("boom")).toEqual({ kind: "transient", message: "boom" });
  });
});

describe("cardScanHint", () => {
  it("never tells an unconfigured user to scan again", () => {
    const hint = cardScanHint({
      kind: "notConfigured",
      message: "OmniRoute URL not configured — set it in Settings",
    });
    expect(hint).toContain("set it in Settings");
    expect(hint).toContain("saved");
    expect(hint).not.toMatch(/scan again to retry/i);
  });

  it("does tell a transient failure to scan again", () => {
    expect(cardScanHint({ kind: "transient", message: "network error" })).toMatch(/scan again/i);
  });

  it("tells a permanent failure that retrying is pointless", () => {
    expect(cardScanHint({ kind: "permanent", message: "bad api key" })).toMatch(/retrying won't help/i);
  });

  it("always confirms the image survived, whatever the cause", () => {
    for (const outcome of [
      { kind: "notConfigured" as const, message: "no url" },
      { kind: "permanent" as const, message: "bad key" },
      { kind: "transient" as const, message: "timeout" },
    ]) {
      expect(cardScanHint(outcome)).toMatch(/saved/i);
    }
  });

  it("has no hint when OCR succeeded", () => {
    expect(cardScanHint({ kind: "ok" })).toBeNull();
  });
});
