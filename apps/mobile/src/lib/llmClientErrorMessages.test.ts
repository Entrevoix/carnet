// ── llmClientErrorMessages.test.ts ────────────────────────────────────────────
// Split out of llmClient.test.ts once that file passed 1078 lines — a
// coherent standalone concern: llmClient.ts merges omniroute.ts + localLlm.ts
// into one code path, but Phase 1 (docs/superpowers/specs/2026-07-31-llm-
// provider-list-design.md) must stay invisible to a reviewer diffing
// enrichment behaviour — including the exact banner text a user sees.
// `config.label` threads the two providers' ORIGINAL, byte-identical wording
// back through the shared code (see the git history of omniroute.ts /
// localLlm.ts). These assert the FULL string, not a substring, specifically
// so a future edit can't silently re-neutralize them back to a generic "LLM
// provider ..." wording. See llmClient.test.ts for the core enrich/promote
// facade tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { enrichIdea, enrichSharedImage, type ProviderConfig } from "./llmClient";

// Mirrors omniroute.test.ts's BASE_SETTINGS-derived config: an https gateway
// with distinct chat/vision models — the OmniRoute-shaped case.
const CONFIG: ProviderConfig = {
  baseUrl: "https://llm.example.com",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  visionModel: "vision-model-xyz",
  label: "OmniRoute",
};

// Mirrors localLlm.test.ts's BASE_SETTINGS-derived config: a loopback server,
// no key, ONE model covering text and vision.
const LOCAL_CONFIG: ProviderConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  model: "test-local-model",
  visionModel: "test-local-model",
  label: "Local LLM",
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe("per-provider error message text (byte-identical to pre-merge omniroute.ts / localLlm.ts)", () => {
  it("OmniRoute: network error message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    const err = await enrichIdea("x", CONFIG).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "OmniRoute network error — Network request failed",
    );
  });

  it("Local LLM: network error message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    const err = await enrichIdea("x", LOCAL_CONFIG).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "Local LLM network error — Network request failed",
    );
  });

  it("OmniRoute: empty/malformed response message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: "x" }), { status: 200 }),
    );
    const err = await enrichIdea("x", CONFIG).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "OmniRoute returned an empty or malformed response",
    );
  });

  it("Local LLM: empty/malformed response message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: "x" }), { status: 200 }),
    );
    const err = await enrichIdea("x", LOCAL_CONFIG).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "Local LLM returned an empty or malformed response",
    );
  });

  it("OmniRoute: timeout message keeps the Tailscale hint", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      const caught = enrichIdea("x", CONFIG).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await caught;
      expect((err as Error).message).toBe(
        "OmniRoute unreachable — timed out after 20s. Check your connection (Tailscale?).",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("Local LLM: timeout message has NO Tailscale hint", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      const caught = enrichIdea("x", LOCAL_CONFIG).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await caught;
      expect((err as Error).message).toBe(
        "Local LLM unreachable — timed out after 20s.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("OmniRoute: blank vision model is UNBRANDED (\"Vision model not configured\"), matching its original dedicated getVisionModel()", async () => {
    const err = await enrichSharedImage(
      { base64: "abc", mimeType: "image/jpeg", context: "" },
      { ...CONFIG, visionModel: "" },
    ).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "Vision model not configured — set it in Settings",
    );
  });

  it("Local LLM: blank vision model reuses the BRANDED model-not-configured message (no separate vision concept)", async () => {
    const err = await enrichSharedImage(
      { base64: "abc", mimeType: "image/jpeg", context: "" },
      { ...LOCAL_CONFIG, visionModel: "" },
    ).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "Local LLM model not configured — set it in Settings",
    );
  });

  it("OmniRoute: https guard message now states the loopback/LAN exemption it always honored", async () => {
    const err = await enrichIdea("x", {
      ...CONFIG,
      baseUrl: "http://evil.example.com",
    }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "OmniRoute URL must use https:// (or be a loopback/LAN address) to protect the API key",
    );
  });

  it("Local LLM: https guard message (unchanged from origin)", async () => {
    const err = await enrichIdea("x", {
      ...LOCAL_CONFIG,
      baseUrl: "http://evil.example.com",
    }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      "Local LLM URL must use https:// (or be a loopback/LAN address) to protect the API key",
    );
  });
});
