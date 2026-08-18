// ── llmClientModels.test.ts ───────────────────────────────────────────────────
// Split out of llmClient.test.ts once that file passed 1078 lines —
// listModels and healthCheck are a coherent standalone concern: provider
// connectivity/discovery probes used by the model browser and the Settings
// screen's "check connection" affordance, distinct from the enrich/promote
// content facade covered in llmClient.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { listModels, healthCheck } from "./llmClient";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("listModels", () => {
  it("fetches GET /v1/models and returns sorted unique ids", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const models = await listModels("http://127.0.0.1:8080", "");

    expect(models).toEqual(["a-model", "b-model"]);
  });
});

// ── healthCheck ───────────────────────────────────────────────────────────────

describe("healthCheck", () => {
  // REGRESSION (#120 fallout): healthCheck used to GET `/health` with no auth.
  // That endpoint belongs to the local-LLM (Relais) server; the merge into the
  // unified client applied it to every provider, so an OpenAI-compatible
  // gateway that serves only `/v1/*` reported "Unreachable" while its real
  // calls succeeded. The old test asserted the URL WAS `/health`, which made it
  // structurally incapable of catching this. Assert the real contract instead:
  // probe the endpoint the app actually uses, authenticated.
  it("probes /v1/models with the API key, never /health", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await healthCheck("http://127.0.0.1:8080", "sk-test")).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/models");
    expect(url).not.toContain("/health");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("omits the Authorization header when no key is configured", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await healthCheck("http://127.0.0.1:8080", "")).toBe("ok");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  // A rejected key is not a dead host. Reporting "check that the server is
  // running" when the server answered sends the user to debug the wrong thing.
  it.each([401, 403])("returns 'unauthorized' on %i", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("", { status }));
    expect(await healthCheck("http://127.0.0.1:8080", "bad-key")).toBe(
      "unauthorized",
    );
  });

  it("returns 'unreachable' when the provider cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    expect(await healthCheck("http://127.0.0.1:8080", "sk-test")).toBe(
      "unreachable",
    );
  });

  it("returns 'unreachable' on a non-auth non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await healthCheck("http://127.0.0.1:8080", "sk-test")).toBe(
      "unreachable",
    );
  });

  // Device-verified 2026-08-01: on a release build Android permits cleartext to
  // loopback but REFUSES it to a LAN address. That surfaces as a rejected fetch
  // indistinguishable from a stopped server, so the user was told "check that
  // the server is running" while their Relais was running fine.
  it("returns 'blocked-cleartext' when the platform refuses plaintext", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError(
        "Cleartext HTTP traffic to 192.168.1.5 not permitted by network security policy",
      ),
    );
    expect(await healthCheck("http://192.168.1.5:8080", "sk-test")).toBe(
      "blocked-cleartext",
    );
  });

  it("returns 'unsafe-url' without issuing a request", async () => {
    expect(await healthCheck("http://example.com:8080", "sk-test")).toBe(
      "unsafe-url",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
