// ── llmClient.test.ts ─────────────────────────────────────────────────────────
// The retargeted omniroute.test.ts + localLlm.test.ts suites — the safety net
// for the Phase 1 client merge (docs/superpowers/specs/2026-07-31-llm-provider-
// list-design.md). llmClient.ts reads no settings, so every call site here
// passes an explicit ProviderConfig instead of the old settings-mock-driven
// getBaseUrl/getApiKey/getModel plumbing. Test bodies are otherwise unchanged
// from their omniroute/localLlm origin — same assertions, same fixtures,
// same fetch-mock shapes — the config argument is the only structural change,
// exactly the class of change the merge's evidence tests were designed to
// tolerate.
//
// transcribeAudio/autoTranscribeIfEnabled moved to dispatcher.ts (they read
// settings + touch the writer, outside llmClient's "reads no settings"
// contract) — their retargeted tests live in dispatcher.test.ts instead.

import { beforeEach, describe, expect, it, vi } from "vitest";

function makeOkResponse(markdown: string, model = "test-model"): Response {
  const body = JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content: markdown } }],
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  const body = JSON.stringify({ error: { message } });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeHtmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  ocrCardViaVision,
  promoteIdea,
  listModels,
  healthCheck,
  LlmClientError,
  isPermanentError,
  isNotConfiguredError,
  isInsecureTransportError,
  assertBase64UnderLimit,
  assertVisionReady,
  MAX_SHARED_IMAGE_BYTES,
  withSystemOverride,
  type ProviderConfig,
} from "./llmClient";
import { HttpError } from "./httpClient";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
} from "./prompts";

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

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

// ── network hard timeout ──────────────────────────────────────────────────────

describe("LLM client request hard timeout", () => {
  it("rejects instead of hanging when the fetch never settles (unreachable host)", async () => {
    // Simulates the provider unreachable (e.g. Tailscale down): the fetch
    // promise never resolves and RN's AbortController.abort() does NOT
    // cancel a stuck connect. Without the Promise.race hard timeout this
    // would hang forever.
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      const assertion = expect(
        enrichIdea("offline thought", CONFIG),
      ).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the timeout as an LlmClientError with status 0 (network-class)", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      // Capture the rejection without an unhandled-rejection while advancing.
      const caught = enrichIdea("offline thought", CONFIG).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await caught;
      expect(err).toBeInstanceOf(LlmClientError);
      expect((err as LlmClientError).status).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when fetch connects but the body read (response.json) never settles", async () => {
    // The subtler hang: the connection succeeds and headers arrive, but the
    // body never closes (LiteLLM SSE). A fetch-only timeout misses this; the
    // whole-operation timeout must still fire because the body read runs
    // inside it.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // body never resolves
      } as unknown as Response);
      const assertion = expect(
        enrichIdea("offline thought", CONFIG),
      ).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

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

// ── enrichIdea ────────────────────────────────────────────────────────────────

describe("enrichIdea", () => {
  it("POSTs to /v1/chat/completions with model + system + user messages", async () => {
    const expectedMarkdown = "---\nstatus: seedling\n---\n# My Idea\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(expectedMarkdown));

    const result = await enrichIdea("my raw idea", CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");

    const prompt = buildIdeaPrompt("my raw idea");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(body.messages[1].content).toContain("my raw idea");

    expect(result.markdown).toBe(expectedMarkdown);
    expect(result.model).toBe("test-model");
  });

  it("parses choices[0].message.content correctly", async () => {
    const md = "---\nstatus: seedling\n---\n# Cool\n\nThought.\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(md, "omni-v2"));
    const result = await enrichIdea("cool thought", CONFIG);
    expect(result.markdown).toBe(md);
    expect(result.model).toBe("omni-v2");
  });

  it("strips defensive code fences from LLM response", async () => {
    const inner = "---\nstatus: seedling\n---\n# Title\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse("```markdown\n" + inner + "```"));
    const result = await enrichIdea("fenced idea", CONFIG);
    expect(result.markdown).toBe(inner.trimEnd());
  });

  it("surfaces HTTP errors with response body in the message", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    await expect(enrichIdea("x", CONFIG)).rejects.toThrow("Invalid API key");
  });

  it("throws LlmClientError with the HTTP status on a 4xx", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect((caught as LlmClientError).status).toBe(401);
    expect(isPermanentError(caught)).toBe(true);
  });

  it("throws LlmClientError with status 0 on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect((caught as LlmClientError).status).toBe(0);
    expect(isPermanentError(caught)).toBe(false);
    // A real network failure is transient (queue it), NOT a config problem.
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("throws a not-configured LlmClientError when the URL is blank", async () => {
    let caught: unknown;
    try {
      await enrichIdea("x", { ...CONFIG, baseUrl: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    // Status 0 like a network error, but flagged not-configured so callers
    // surface it instead of silently queuing for an endpoint that can't exist.
    expect((caught as LlmClientError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(isPermanentError(caught)).toBe(false);
    expect((caught as LlmClientError).message).toMatch(/not configured/i);
    // No fetch should even be attempted with a blank URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts Bearer tokens from network error messages", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });

  it("throws when choices array is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: "x" }), { status: 200 }),
    );
    await expect(enrichIdea("x", CONFIG)).rejects.toThrow("empty or malformed");
  });

  it("posts to the configured base URL's /v1/chat/completions with no Authorization header when no API key is set", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought", LOCAL_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });

  it("sends an Authorization header when a local-LLM API key is configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought", { ...LOCAL_CONFIG, apiKey: "local-secret" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local-secret");
  });

  it("classifies a 4xx response as a permanent LlmClientError", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, "bad request"));

    const err = await enrichIdea("doomed", LOCAL_CONFIG).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LlmClientError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

// ── enrichJournal ─────────────────────────────────────────────────────────────

describe("enrichJournal", () => {
  it("POSTs with the journal prompt containing transcript", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\ndate: 2026-05-16\n---\n# Summary\n"),
    );
    await enrichJournal({ transcript: "today I met Alice", notes: "" }, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildJournalPrompt("today I met Alice", "");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
  });
});

// ── enrichPerson ──────────────────────────────────────────────────────────────

describe("enrichPerson", () => {
  it("POSTs with the person prompt containing OCR and context", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nname: Jane Doe\n---\n# Jane Doe\n"),
    );
    await enrichPerson({ ocrResult: "Jane Doe, CEO", context: "met at conference" }, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildPersonPrompt("Jane Doe, CEO", "met at conference");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
  });
});

// ── promoteIdea ───────────────────────────────────────────────────────────────

describe("promoteIdea", () => {
  it("POSTs with the promote prompt and returns updated markdown", async () => {
    const updatedMd = "---\nstatus: developing\n---\n# My Idea\n\nMore developed.\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(updatedMd));

    const currentMd = "---\nstatus: seedling\n---\n# My Idea\n\nRaw thought.\n";
    const result = await promoteIdea(currentMd, "developing", CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildPromoteIdeaPrompt(currentMd, "developing");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(result.markdown).toBe(updatedMd);
  });
});

// ── model routing: chat vs vision (B1 model split) ───────────────────────────

describe("model routing (chat text vs image vision)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("enrichSharedImage requests the vision model, not the chat model", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nkind: shared-image\n---\n# Photo\n"),
    );

    await enrichSharedImage(
      { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "test ctx" },
      CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    // CONFIG: model = "gpt-4o-mini", visionModel = "vision-model-xyz".
    expect(body.model).toBe("vision-model-xyz");
    expect(body.model).not.toBe("gpt-4o-mini");
  });

  it("enrichIdea requests the chat model, not the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await enrichIdea("a plain thought", CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.model).not.toBe("vision-model-xyz");
  });

  it("enrichJournal requests the chat model, not the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# j\n"));
    await enrichJournal({ transcript: "today", notes: "" }, CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("surfaces a not-configured LlmClientError when the vision model is blank", async () => {
    // Blank vision model must route through the SAME isNotConfiguredError
    // degraded path as a blank URL — never a crash, never a new error shape,
    // and never a silent fetch to a text-only fallback model.
    let caught: unknown;
    try {
      await enrichSharedImage(
        { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "ctx" },
        { ...CONFIG, visionModel: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(isPermanentError(caught)).toBe(false);
    expect((caught as LlmClientError).status).toBe(0);
    // No fetch attempted — the config gap short-circuits before the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── HTTPS enforcement ─────────────────────────────────────────────────────────

describe("HTTPS enforcement", () => {
  it("rejects http:// URLs (non-localhost)", async () => {
    await expect(
      enrichIdea("x", { ...CONFIG, baseUrl: "http://evil.example.com" }),
    ).rejects.toThrow(/https:\/\//);
    // Ensure no fetch was attempted
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http://localhost for dev", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await expect(
      enrichIdea("x", { ...CONFIG, baseUrl: "http://localhost:8080", apiKey: "" }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ── per-provider error message text ───────────────────────────────────────────
// llmClient.ts merges omniroute.ts + localLlm.ts into one code path, but Phase
// 1 must stay invisible to a reviewer diffing enrichment behaviour — including
// the exact banner text a user sees. `config.label` threads the two providers'
// ORIGINAL, byte-identical wording back through the shared code (see
// docs/superpowers/specs/2026-07-31-llm-provider-list-design.md and the
// git history of omniroute.ts / localLlm.ts). These assert the FULL string,
// not a substring, specifically so a future edit can't silently re-neutralize
// them back to a generic "LLM provider ..." wording.
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

// ── enrichSharedLink ──────────────────────────────────────────────────────────

describe("enrichSharedLink", () => {
  it("rejects a blank config URL immediately, without awaiting the preview fetch", async () => {
    // The preview fetch NEVER resolves. If enrichSharedLink awaited it before
    // checking config.baseUrl, this test would hang until vitest's own test
    // timeout — proving the not-configured check must fire before the
    // `await previewPromise`, not after (a blank-URL user must not wait on
    // fetchUrlPreview's 8s internal timeout for a spinner that was always
    // going nowhere).
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    await expect(
      enrichSharedLink(
        { url: "https://example.com/article", text: "", context: "" },
        { ...CONFIG, baseUrl: "" },
      ),
    ).rejects.toThrow(/not configured/i);

    // Only the not-configured check ran — the preview fetch was never
    // resolved/consumed, and no chat-completion POST was ever reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the URL preview and threads it into the chat prompt", async () => {
    const previewHtml = `
      <html><head>
        <title>Plain Title</title>
        <meta property="og:title" content="A Real Article">
        <meta property="og:description" content="Detailed summary here.">
        <meta property="og:site_name" content="Example News">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(makeHtmlResponse(previewHtml));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Saved Article\n\nbody\n"),
    );

    const result = await enrichSharedLink(
      { url: "https://example.com/article", text: "", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call: GET the page for preview
    const [previewUrl, previewInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(previewUrl).toBe("https://example.com/article");
    expect(previewInit.method).toBe("GET");
    // Second call: POST to chat completions with preview lines in user content
    const [chatUrl, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(chatUrl).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    expect(body.messages[1].role).toBe("user");
    const userContent = body.messages[1].content;
    expect(userContent).toContain("Site: Example News");
    expect(userContent).toContain("Page title: A Real Article");
    expect(userContent).toContain("Page description: Detailed summary here.");
    expect(userContent).toContain("URL: https://example.com/article");
    expect(result.markdown).toContain("Saved Article");
  });

  it("falls back to URL-string-only prompt when preview fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Fallback Note\n"),
    );

    const result = await enrichSharedLink(
      { url: "https://offline.example.com/p", text: "", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    const userContent = body.messages[1].content;
    // Structural assertion: URL still present, no preview lines injected.
    // We deliberately do not assert on system-prompt wording — that copy
    // is allowed to evolve without breaking this test.
    expect(userContent).toContain("URL: https://offline.example.com/p");
    expect(userContent).not.toContain("Site:");
    expect(userContent).not.toContain("Page title:");
    expect(userContent).not.toContain("Page description:");
    expect(result.markdown).toContain("Fallback Note");
  });

  it("skips the preview fetch when no URL is provided (text-only share)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Text Note\n"),
    );

    await enrichSharedLink(
      { url: "", text: "Some shared snippet of text without a URL.", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [chatUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(chatUrl).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("invokes onPreviewSettled exactly once when the preview promise resolves", async () => {
    const previewHtml = `<html><head><title>x</title></head></html>`;
    fetchMock.mockResolvedValueOnce(makeHtmlResponse(previewHtml));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# y\n"),
    );

    const settled = vi.fn();
    await enrichSharedLink(
      { url: "https://example.com/cb", text: "", context: "", onPreviewSettled: settled },
      CONFIG,
    );

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("invokes onPreviewSettled even when the preview fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# y\n"),
    );

    const settled = vi.fn();
    await enrichSharedLink(
      { url: "https://example.com/cb-fail", text: "", context: "", onPreviewSettled: settled },
      CONFIG,
    );

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("does not include preview lines when preview returns null fields", async () => {
    // Preview fetch succeeds but the page has no title or description.
    fetchMock.mockResolvedValueOnce(
      makeHtmlResponse("<html><head></head><body></body></html>"),
    );
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Empty-page Note\n"),
    );

    await enrichSharedLink(
      { url: "https://blank.example.com/", text: "", context: "" },
      CONFIG,
    );

    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    const userContent = body.messages[1].content;
    expect(userContent).not.toContain("Site:");
    expect(userContent).not.toContain("Page title:");
  });
});

// ── withSystemOverride (pure helper) ──────────────────────────────────────────

describe("withSystemOverride", () => {
  const pair = { system: "default-system", user: "user-content" };

  it("returns the pair unchanged when override is undefined", () => {
    expect(withSystemOverride(pair, undefined)).toEqual(pair);
  });

  it("returns the pair unchanged when override is an empty string", () => {
    expect(withSystemOverride(pair, "")).toEqual(pair);
  });

  it("returns the pair unchanged when override is whitespace only", () => {
    expect(withSystemOverride(pair, "   \n\t ")).toEqual(pair);
  });

  it("swaps in the override system, preserving the user content", () => {
    const result = withSystemOverride(pair, "my custom system");
    expect(result).toEqual({
      system: "my custom system",
      user: "user-content",
    });
  });

  it("trims surrounding whitespace from the override", () => {
    const result = withSystemOverride(pair, "  trimmed  ");
    expect(result.system).toBe("trimmed");
  });
});

// ── journal + person tag slots (the LLM-tagging gap closure) ──────────────────

describe("journal + person prompts auto-tagging", () => {
  it("buildJournalPrompt requests 2-3 tags and exposes slots in frontmatter", () => {
    const { system } = buildJournalPrompt("woke up early, ran 5k", "");
    // Instruction line
    expect(system).toMatch(/Suggest 2-3 relevant tags/i);
    // Frontmatter slots — tags array starts with `journal` then user slots
    expect(system).toContain("tags: [journal, {tag1}, {tag2}]");
  });

  it("buildPersonPrompt requests tags and adds them after the base tags", () => {
    const { system } = buildPersonPrompt("John Doe\nAcme Inc.", "met at conf");
    expect(system).toMatch(/suggest 2-3 relevant tags/i);
    expect(system).toContain("tags: [person, networking, {tag1}, {tag2}]");
  });
});

// ── enrich entry points honor prompt overrides ────────────────────────────────

describe("enrich entry points honor prompt overrides", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("enrichIdea uses the override system message when configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea(
      "the override should reach the API",
      CONFIG,
      "You are an extremely terse summariser. Respond in one line.",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(
      "You are an extremely terse summariser. Respond in one line.",
    );
  });

  it("enrichIdea falls back to default when override is empty", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("default path", CONFIG, "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    // Default idea prompt contains its signature phrase
    expect(body.messages[0].content).toMatch(
      /Suggest 2-3 relevant tags|personal knowledge assistant/,
    );
  });

  it("enrichJournal applies the journal override, not the idea override", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichJournal({ transcript: "test", notes: "" }, CONFIG, "journal-custom");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].content).toBe("journal-custom");
  });

  it("enrichSharedImage applies the sharedImage override via its inline splice", async () => {
    // sharedImage uses an inline splice (not withSystemOverride) because its
    // user content is OpenAIMessage[] not PromptPair — pin the inline path so
    // it can't drift from the helper-driven entry points silently.
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(
        "---\nkind: shared-image\n---\n# x\n\n## What's in this\nstuff\n",
      ),
    );

    await enrichSharedImage(
      { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "test ctx" },
      CONFIG,
      "shared-image-custom-system",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("shared-image-custom-system");
    // User content stays multimodal (the image bytes still attach)
    expect(Array.isArray(body.messages[1].content)).toBe(true);
  });
});

// ── listModels ────────────────────────────────────────────────────────────────

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

// ── ocrCardViaVision (business-card OCR folded into chat vision, B2) ───────────
describe("ocrCardViaVision", () => {
  const CARD_PROMPT =
    "Transcribe ALL text on this business card exactly as printed. Preserve every field: name, title, company, phone numbers, email addresses, websites, physical address, and any other text. Output plain text, one field per line. Do not invent, omit, or normalize anything.";

  it("posts a single multimodal user turn to /v1/chat/completions using the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\nACME"));

    const result = await ocrCardViaVision(
      { base64: "QkFTRTY0", mimeType: "image/png" },
      CONFIG,
    );

    expect(result).toEqual({ text: "Jane Doe\nCEO\nACME" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      temperature: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    // Vision model, not the chat model; deterministic; non-streaming.
    expect(body.model).toBe("vision-model-xyz");
    expect(body.model).not.toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    // Single user turn only — no system message.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: CARD_PROMPT },
      { type: "image_url", image_url: { url: "data:image/png;base64,QkFTRTY0" } },
    ]);
    // Auth header threaded through.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("preserves model output verbatim for raw OCR provenance", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("  Jane Doe, CEO \n"));
    const result = await ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG);
    expect(result).toEqual({ text: "  Jane Doe, CEO \n" });
  });

  it("falls back to image/jpeg for a non-allowlisted mime", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision({ base64: "abc", mimeType: "application/octet-stream" }, CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[0].content[1].image_url?.url).toBe(
      "data:image/jpeg;base64,abc",
    );
  });

  it("throws 'no OCR text' when the model returns empty content", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("   "));
    await expect(
      ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG),
    ).rejects.toThrow("OmniRoute response contained no OCR text");
  });

  it("surfaces a permanent LlmClientError on a 4xx response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isPermanentError(caught)).toBe(true);
  });

  it("surfaces a not-configured LlmClientError when the vision model is blank", async () => {
    let caught: unknown;
    try {
      await ocrCardViaVision(
        { base64: "abc", mimeType: "image/jpeg" },
        { ...CONFIG, visionModel: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a not-configured LlmClientError when the URL is blank", async () => {
    let caught: unknown;
    try {
      await ocrCardViaVision(
        { base64: "abc", mimeType: "image/jpeg" },
        { ...CONFIG, baseUrl: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Parity guarantees carried over from the retired ocr.test.ts: URL trim and
  // no-key header omission were explicit assertions for the old /v1/ocr client
  // and must hold for the vision path too.
  it("trims trailing slashes from the base URL", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision(
      { base64: "abc", mimeType: "image/jpeg" },
      { ...CONFIG, baseUrl: "https://llm.example.com///" },
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision(
      { base64: "abc", mimeType: "image/jpeg" },
      { ...CONFIG, apiKey: "" },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("uses the single configured model (no separate vision model) for the local backend", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\njane@example.com"));

    const result = await ocrCardViaVision(
      { base64: "abc123", mimeType: "image/jpeg" },
      LOCAL_CONFIG,
    );

    expect(result.text).toBe("Jane Doe\nCEO\njane@example.com");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
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
