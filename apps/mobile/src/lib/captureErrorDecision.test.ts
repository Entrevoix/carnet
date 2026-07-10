import { beforeEach, describe, expect, it, vi } from "vitest";

const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
}));

import {
  classifyCaptureError,
  OMNIROUTE_NOT_CONFIGURED_MESSAGE,
} from "./captureErrorDecision";

beforeEach(() => {
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
});

describe("classifyCaptureError", () => {
  it("surfaces the config message (not a queue) when the URL is unset", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("no url"));
    expect(decision).toEqual({
      kind: "notConfigured",
      message: OMNIROUTE_NOT_CONFIGURED_MESSAGE,
    });
  });

  it("surfaces the real message for a permanent (4xx) failure", () => {
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("HTTP 400 bad model"));
    expect(decision).toEqual({ kind: "permanent", message: "HTTP 400 bad model" });
  });

  it("stringifies a non-Error permanent failure", () => {
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError("boom");
    expect(decision).toEqual({ kind: "permanent", message: "boom" });
  });

  it("classifies a network/5xx failure as transient (caller should queue)", () => {
    const decision = classifyCaptureError(new Error("network down"));
    expect(decision).toEqual({ kind: "transient" });
  });

  it("prefers not-configured over permanent when both would match", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("x"));
    expect(decision.kind).toBe("notConfigured");
  });
});
