// ── llmHttp.test.ts ─────────────────────────────────────────────────────────
// Covers resolveEnrichmentTimeoutMs (issue #179): local providers (Relais on
// loopback, a custom LAN entry) get the long inference tier; everything else
// keeps the short reachability-probe tier. See llmClientErrorMessages.test.ts
// for the integration-level assertion that enrichIdea actually plumbs this
// through to the fetch/withTimeout layer for a local-URL ProviderConfig.

import { describe, expect, it } from "vitest";
import { ENHANCE_TIMEOUT_MS, FETCH_TIMEOUT_MS, resolveEnrichmentTimeoutMs } from "./llmHttp";

describe("resolveEnrichmentTimeoutMs (#179 — provider-aware enrichment timeout)", () => {
  it("loopback URL -> long tier", () => {
    expect(resolveEnrichmentTimeoutMs("http://127.0.0.1:8080")).toBe(ENHANCE_TIMEOUT_MS);
    expect(resolveEnrichmentTimeoutMs("http://localhost:8080")).toBe(ENHANCE_TIMEOUT_MS);
  });

  it("LAN IP -> long tier", () => {
    expect(resolveEnrichmentTimeoutMs("http://192.168.1.42:8080")).toBe(ENHANCE_TIMEOUT_MS);
    expect(resolveEnrichmentTimeoutMs("http://10.0.0.5:8080")).toBe(ENHANCE_TIMEOUT_MS);
    expect(resolveEnrichmentTimeoutMs("http://172.16.0.9:8080")).toBe(ENHANCE_TIMEOUT_MS);
  });

  it("https remote -> short tier (negative control: not every scheme/host is local)", () => {
    expect(resolveEnrichmentTimeoutMs("https://llm.example.com")).toBe(FETCH_TIMEOUT_MS);
    // A public IP outside the RFC1918 ranges must NOT be misclassified as LAN.
    expect(resolveEnrichmentTimeoutMs("http://172.32.0.9")).toBe(FETCH_TIMEOUT_MS);
    expect(resolveEnrichmentTimeoutMs("http://8.8.8.8")).toBe(FETCH_TIMEOUT_MS);
  });

  it("blank baseUrl -> short tier (relais-blank case never reaches here)", () => {
    // dispatcher.ts's buildConfig substitutes DEFAULT_LOCAL_LLM_URL
    // (llmClient.ts, "http://127.0.0.1:8080") for a blank relais baseUrl
    // BEFORE building the ProviderConfig every enrichment call site here
    // receives — so a blank string is never actually passed to this
    // function for relais in practice. This case exists only to pin that a
    // literally blank baseUrl (e.g. a future caller that skips dispatcher)
    // is NOT silently treated as local — isLocalNetworkUrl (netAllowlist.ts)
    // fails `new URL("")` and returns false, same as any other malformed URL.
    expect(resolveEnrichmentTimeoutMs("")).toBe(FETCH_TIMEOUT_MS);
  });
});
