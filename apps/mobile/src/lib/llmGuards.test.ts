// ── llmGuards.test.ts ────────────────────────────────────────────────────────
// Move-only split of llmClient.test.ts along the llmGuards.ts seam — the
// config-precondition asserts (image size cap, vision-readiness). See
// llmClient.test.ts's header comment for the origin of this suite.

import { describe, expect, it } from "vitest";
import { assertBase64UnderLimit, assertVisionReady, MAX_SHARED_IMAGE_BYTES } from "./llmGuards";
import {
  isInsecureTransportError,
  isNotConfiguredError,
  isPermanentError,
  LlmClientError,
} from "./llmErrors";
// Test-only: importing ProviderConfig here does not create a production
// import cycle (llmGuards.ts itself never imports from ./llmClient) — test
// files aren't part of the runtime module graph, so this is safe even
// though llmGuards.ts's own assertVisionReady takes VisionReadyConfig to
// avoid exactly that cycle in production code.
import type { ProviderConfig } from "./llmClient";

// ── assertBase64UnderLimit ────────────────────────────────────────────────────

describe("assertBase64UnderLimit", () => {
  it("does not throw for a clearly small payload", () => {
    expect(() => assertBase64UnderLimit("abcd")).not.toThrow();
  });

  it("does not throw at exactly the cap", () => {
    // base64.length × 0.75 must equal MAX_SHARED_IMAGE_BYTES, not exceed it.
    // length = ceil(MAX / 0.75) such that floor(length * 0.75) === MAX.
    // 8 * 1024 * 1024 / 0.75 = 11_184_810.67 → length 11_184_811 → 8_388_608.
    const cappedLen = Math.ceil(MAX_SHARED_IMAGE_BYTES / 0.75);
    const base64 = "A".repeat(cappedLen);
    expect(() => assertBase64UnderLimit(base64)).not.toThrow();
  });

  it("throws LlmClientError when payload exceeds the cap", () => {
    // 16 MB worth of base64 chars — decodes to 12 MB, clearly over the 8 MB cap.
    const base64 = "A".repeat(16 * 1024 * 1024);
    expect(() => assertBase64UnderLimit(base64)).toThrow(LlmClientError);
  });

  it("error carries status 413 and a descriptive MB message", () => {
    const base64 = "A".repeat(16 * 1024 * 1024);
    try {
      assertBase64UnderLimit(base64);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LlmClientError);
      const err = e as LlmClientError;
      expect(err.status).toBe(413);
      expect(err.message).toMatch(/MB/);
      expect(err.message).toMatch(/caps at/);
    }
  });

  it("is classified as a permanent error by isPermanentError", () => {
    const base64 = "A".repeat(16 * 1024 * 1024);
    try {
      assertBase64UnderLimit(base64);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect(isPermanentError(e)).toBe(true);
    }
  });
});

describe("assertVisionReady", () => {
  const ready: ProviderConfig = {
    baseUrl: "https://llm.example.com/",
    apiKey: "k",
    model: "m",
    visionModel: "vm",
    label: "OmniRoute",
  };

  it("returns the resolved model and a trailing-slash-trimmed url", () => {
    expect(assertVisionReady(ready)).toEqual({ model: "vm", url: "https://llm.example.com" });
  });

  it("flags a blank vision model as not-configured", () => {
    let caught: unknown;
    try {
      assertVisionReady({ ...ready, visionModel: "" });
    } catch (e: unknown) {
      caught = e;
    }
    expect(isNotConfiguredError(caught)).toBe(true);
  });

  it("flags a blank url as not-configured", () => {
    let caught: unknown;
    try {
      assertVisionReady({ ...ready, baseUrl: "" });
    } catch (e: unknown) {
      caught = e;
    }
    expect(isNotConfiguredError(caught)).toBe(true);
  });

  it("flags a plain-http remote url as insecure transport, NOT as not-configured", () => {
    // The two flags must stay distinct: dispatcher's shouldRetryWithFallback
    // keys off isNotConfiguredError, and an insecure primary has to keep
    // falling back to a working secondary.
    let caught: unknown;
    try {
      assertVisionReady({ ...ready, baseUrl: "http://llm.example.com" });
    } catch (e: unknown) {
      caught = e;
    }
    expect(isInsecureTransportError(caught)).toBe(true);
    expect(isNotConfiguredError(caught)).toBe(false);
    expect(isPermanentError(caught)).toBe(false);
  });

  it("leaves insecureTransport false on the not-configured errors", () => {
    let caught: unknown;
    try {
      assertVisionReady({ ...ready, baseUrl: "" });
    } catch (e: unknown) {
      caught = e;
    }
    expect(isInsecureTransportError(caught)).toBe(false);
  });

  it("reports the vision model first when everything is blank", () => {
    // Order is load-bearing: ocrCardViaVision shares this function, so the
    // message a user sees must not change with the extraction.
    expect(() => assertVisionReady({ ...ready, baseUrl: "", visionModel: "" }))
      .toThrow(/vision model/i);
  });
});
