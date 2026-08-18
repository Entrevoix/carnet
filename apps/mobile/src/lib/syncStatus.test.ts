import { describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({
  getQueueCounts: vi.fn(async () => ({ pending: 2, failed: 1 })),
}));

// getSyncStatus resolves the active provider's label via Settings; mocked
// directly (rather than the real settings.ts + AsyncStorage/SecureStore
// stack) since deriveSyncStatus's copy is what's under test here.
vi.mock("./settings", () => ({
  getSettings: vi.fn(async () => ({
    llmProviders: [{ id: "omniroute", label: "OmniRoute", baseUrl: "", model: "", visionModel: "", preset: "omniroute" }],
    activeProviderId: "omniroute",
  })),
}));

import { deriveSyncStatus, getSyncStatus } from "./syncStatus";

describe("deriveSyncStatus", () => {
  it("is idle with an empty queue", () => {
    const s = deriveSyncStatus(0, 0);
    expect(s.state).toBe("idle");
    expect(s.detail).toMatch(/enriched/);
  });

  it("is pending when rows await retry", () => {
    const s = deriveSyncStatus(3, 0, "OmniRoute");
    expect(s.state).toBe("pending");
    expect(s.pending).toBe(3);
    expect(s.detail).toMatch(/3 captures waiting/);
    expect(s.detail).toMatch(/finish automatically when OmniRoute is reachable/);
  });

  it("uses singular copy for one pending capture", () => {
    expect(deriveSyncStatus(1, 0).detail).toMatch(/1 capture waiting/);
  });

  it("names the active provider in the pending detail", () => {
    expect(deriveSyncStatus(1, 0, "Groq").detail).toMatch(
      /finish automatically when Groq is reachable/,
    );
  });

  it("falls back to provider-neutral phrasing when no label is supplied", () => {
    expect(deriveSyncStatus(1, 0).detail).toMatch(
      /finish automatically when your LLM provider is reachable/,
    );
  });

  it("error wins over pending", () => {
    const s = deriveSyncStatus(2, 1, "OmniRoute");
    expect(s.state).toBe("error");
    expect(s.pending).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.detail).toMatch(/1 capture couldn't be enriched/);
    expect(s.detail).toMatch(/check the OmniRoute settings/);
  });

  it("names the active provider in the error detail", () => {
    expect(deriveSyncStatus(0, 1, "Groq").detail).toMatch(/check the Groq settings/);
  });
});

describe("getSyncStatus", () => {
  it("derives from queue counts and names the active provider", async () => {
    const s = await getSyncStatus();
    expect(s.state).toBe("error");
    expect(s.pending).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.detail).toMatch(/check the OmniRoute settings/);
  });
});
