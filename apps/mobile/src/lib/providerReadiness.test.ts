import { beforeEach, describe, expect, it, vi } from "vitest";

// llmClient.ts pulls in the fetch/timeout machinery this module doesn't need
// to exercise directly — mock healthCheck at the boundary, same seam
// cardScanOutcome.test.ts uses for dispatcher.
const healthCheckMock =
  vi.fn<(baseUrl: string, apiKey: string, allowInsecureTransport?: boolean) => Promise<string>>();

vi.mock("./llmClient", () => ({
  healthCheck: (...args: unknown[]) =>
    healthCheckMock(...(args as [string, string, boolean?])),
}));

import {
  isLocalProvider,
  localProviderHint,
  probeLocalProviderReachability,
} from "./providerReadiness";

beforeEach(() => {
  healthCheckMock.mockReset();
});

describe("isLocalProvider", () => {
  it("classifies an https remote base URL as not local", () => {
    expect(isLocalProvider({ id: "openai", baseUrl: "https://api.openai.com" })).toBe(
      false,
    );
  });

  it("classifies an http loopback base URL as local", () => {
    expect(isLocalProvider({ id: "relais", baseUrl: "http://127.0.0.1:8080" })).toBe(
      true,
    );
  });

  it("classifies an http LAN base URL as local", () => {
    expect(
      isLocalProvider({ id: "custom-1", baseUrl: "http://192.168.1.50:8080" }),
    ).toBe(true);
  });

  it("classifies an https LAN base URL as local too — scheme doesn't matter, only the host", () => {
    expect(isLocalProvider({ id: "custom-1", baseUrl: "https://10.0.0.5:8443" })).toBe(
      true,
    );
  });

  it("treats a blank base URL as the Relais loopback default ONLY for the relais preset itself, matching healthCheck", () => {
    expect(isLocalProvider({ id: "relais", baseUrl: "" })).toBe(true);
    expect(isLocalProvider({ id: "relais", baseUrl: "   " })).toBe(true);
  });

  it("does NOT treat a blank base URL as local for any other provider — an unconfigured cloud gateway is not a local one", () => {
    // Mirrors LlmProviderSection.tsx's canTestConnection precedent: a blank
    // OmniRoute URL must never be silently treated as loopback-probeable.
    expect(isLocalProvider({ id: "omniroute", baseUrl: "" })).toBe(false);
    expect(isLocalProvider({ id: "custom-1", baseUrl: "" })).toBe(false);
  });

  it("classifies an unparseable base URL as not local", () => {
    expect(isLocalProvider({ id: "custom-1", baseUrl: "not a url" })).toBe(false);
  });
});

describe("probeLocalProviderReachability", () => {
  it("maps an ok healthCheck result to ok", async () => {
    healthCheckMock.mockResolvedValue("ok");
    await expect(
      probeLocalProviderReachability("http://127.0.0.1:8080", ""),
    ).resolves.toBe("ok");
  });

  it.each([
    "unreachable",
    "unauthorized",
    "blocked-cleartext",
    "unsafe-url",
    "untrusted-tls",
  ])(
    "maps a %s healthCheck result to unreachable",
    async (result) => {
      healthCheckMock.mockResolvedValue(result);
      await expect(
        probeLocalProviderReachability("http://127.0.0.1:8080", ""),
      ).resolves.toBe("unreachable");
    },
  );

  it("maps a rejected healthCheck to unreachable rather than propagating", async () => {
    healthCheckMock.mockRejectedValue(new Error("boom"));
    await expect(
      probeLocalProviderReachability("http://127.0.0.1:8080", ""),
    ).resolves.toBe("unreachable");
  });

  it("maps a thrown (sync) healthCheck to unreachable rather than propagating", async () => {
    healthCheckMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(
      probeLocalProviderReachability("http://127.0.0.1:8080", ""),
    ).resolves.toBe("unreachable");
  });

  it("passes the base URL and api key straight through to healthCheck, allowInsecureTransport defaulted false", async () => {
    healthCheckMock.mockResolvedValue("ok");
    await probeLocalProviderReachability("http://127.0.0.1:8080", "secret-key");
    expect(healthCheckMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080",
      "secret-key",
      false,
    );
  });

  // #176 HIGH fix: without forwarding this, a provider the user consented to
  // for enrichment would still fail its OWN readiness probe and show a
  // permanent "Not reachable" hint even while enrichment succeeded.
  it("forwards an explicit allowInsecureTransport: true to healthCheck", async () => {
    healthCheckMock.mockResolvedValue("ok");
    await probeLocalProviderReachability("http://tailnet.example:8080", "secret-key", true);
    expect(healthCheckMock).toHaveBeenCalledWith(
      "http://tailnet.example:8080",
      "secret-key",
      true,
    );
  });
});

describe("localProviderHint", () => {
  it("returns copy for an unreachable state", () => {
    expect(localProviderHint("unreachable")).toMatch(/not reachable/i);
  });

  it("mentions queueing, not disabling", () => {
    const hint = localProviderHint("unreachable");
    expect(hint).toMatch(/queue/i);
    expect(hint).not.toMatch(/disabled/i);
  });

  it("returns null for an ok state", () => {
    expect(localProviderHint("ok")).toBeNull();
  });

  it("returns null when not yet probed", () => {
    expect(localProviderHint(undefined)).toBeNull();
  });
});
