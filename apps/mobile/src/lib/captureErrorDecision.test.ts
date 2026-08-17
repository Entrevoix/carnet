import { beforeEach, describe, expect, it, vi } from "vitest";

const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);
const isInsecureTransportErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
  isInsecureTransportError: (...args: unknown[]) => isInsecureTransportErrorMock(...args),
}));

import {
  classifyCaptureError,
  OMNIROUTE_NOT_CONFIGURED_MESSAGE,
} from "./captureErrorDecision";

beforeEach(() => {
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
  isInsecureTransportErrorMock.mockReturnValue(false);
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

  it("surfaces an insecure-transport failure as config (never queued)", () => {
    isInsecureTransportErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("Insecure URL: use https:// for remote hosts"));
    // notConfigured, so the screen surfaces it and keeps the text — the same
    // no-enqueue path a blank URL takes. Queuing it would strand the row: the
    // drain now breaks on this error, blocking every healthy row behind it.
    expect(decision).toEqual({
      kind: "notConfigured",
      message: "Insecure URL: use https:// for remote hosts",
    });
  });

  it("keeps the provider's wording for insecure transport rather than the canonical config message", () => {
    // The message names the offending URL; flattening it into the OmniRoute
    // constant would tell the user to set a URL that is already set.
    isInsecureTransportErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("Insecure URL: http://box.example"));
    expect(decision).not.toEqual({
      kind: "notConfigured",
      message: OMNIROUTE_NOT_CONFIGURED_MESSAGE,
    });
    expect(decision.kind).not.toBe("transient");
  });

  it("prefers insecure-transport over permanent when both would match", () => {
    isInsecureTransportErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("x"));
    expect(decision.kind).toBe("notConfigured");
  });

  it("prefers not-configured over permanent when both would match", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("x"));
    expect(decision.kind).toBe("notConfigured");
  });
});
