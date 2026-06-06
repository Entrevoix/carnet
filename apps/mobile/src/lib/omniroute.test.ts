import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock settings ─────────────────────────────────────────────────────────────
// BASE_SETTINGS is the default getSettings() shape (autoTranscribeOnSave OFF).
// Hoisted via vi.hoisted so it can be referenced BOTH inside the vi.mock
// factory (which vitest hoists above module scope) AND by SETTINGS_TOGGLE_ON
// in the autoTranscribeIfEnabled block — one source of truth for the 8-field
// Settings shape, so an interface change touches one fixture, not two.
const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    omniRouteUrl: "https://llm.example.com",
    omniRouteApiKey: "test-key",
    omniRouteModel: "gpt-4o-mini",
    omniRouteTranscriptionModel: "gemini/gemini-2.5-flash-lite",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    captureFolderPath: "",
    promptOverrides: {},
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
  // Used by each enrich entry point to load per-mode prompt overrides.
  // Default-empty so existing tests get the default-prompt behavior.
  getPromptOverrides: vi.fn().mockResolvedValue({}),
}));

// Mock the writer module so autoTranscribeIfEnabled's readNote /
// readPairedBinaryFromNote / updateNote / upsertSection paths are
// controllable per-test. Only autoTranscribeIfEnabled in omniroute.ts
// touches writer; existing tests don't care about the mocked shape.
vi.mock("./writer", () => ({
  readNote: vi.fn(),
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(),
  upsertSection: vi.fn(
    (md: string, heading: string, body: string) =>
      `${md}\n\n## ${heading}\n\n${body}\n`,
  ),
}));

// Mock the on-device transcription wrapper at the module boundary.
// transcribeAudio dynamic-imports this module; vitest's hoisted vi.mock
// intercepts both static and dynamic imports, so the mock is live inside
// transcribeAudio's `await import("./audioTranscribeOnDevice")`.
vi.mock("./audioTranscribeOnDevice", () => ({
  transcribeOnDevice: vi.fn(),
}));

// ── Mock fetch ────────────────────────────────────────────────────────────────
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

// Use a global fetch mock
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  enrichSharedLink,
  autoTranscribeIfEnabled,
  promoteIdea,
  transcribeAudio,
  OmniRouteError,
  isPermanentError,
  isNotConfiguredError,
  assertBase64UnderLimit,
  MAX_SHARED_IMAGE_BYTES,
  MAX_TRANSCRIPTION_BYTES,
  withSystemOverride,
} from "./omniroute";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
} from "./prompts";

function makeHtmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

beforeEach(() => {
  fetchMock.mockReset();
});

// ── network hard timeout ──────────────────────────────────────────────────────

describe("OmniRoute request hard timeout", () => {
  it("rejects instead of hanging when the fetch never settles (unreachable host)", async () => {
    // Simulates OmniRoute unreachable (e.g. Tailscale down): the fetch promise
    // never resolves and RN's AbortController.abort() does NOT cancel a stuck
    // connect. Without the Promise.race hard timeout this would hang forever.
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      const assertion = expect(enrichIdea("offline thought")).rejects.toThrow(
        /timed out/i,
      );
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the timeout as an OmniRouteError with status 0 (network-class)", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      // Capture the rejection without an unhandled-rejection while advancing.
      const caught = enrichIdea("offline thought").then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await caught;
      expect(err).toBeInstanceOf(OmniRouteError);
      expect((err as OmniRouteError).status).toBe(0);
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
      const assertion = expect(enrichIdea("offline thought")).rejects.toThrow(
        /timed out/i,
      );
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

  it("throws OmniRouteError when payload exceeds the cap", () => {
    // 16 MB worth of base64 chars — decodes to 12 MB, clearly over the 8 MB cap.
    const base64 = "A".repeat(16 * 1024 * 1024);
    expect(() => assertBase64UnderLimit(base64)).toThrow(OmniRouteError);
  });

  it("error carries status 413 and a descriptive MB message", () => {
    const base64 = "A".repeat(16 * 1024 * 1024);
    try {
      assertBase64UnderLimit(base64);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(OmniRouteError);
      const err = e as OmniRouteError;
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

// ── enrichIdea ────────────────────────────────────────────────────────────────

describe("enrichIdea", () => {
  it("POSTs to /v1/chat/completions with model + system + user messages", async () => {
    const expectedMarkdown = "---\nstatus: seedling\n---\n# My Idea\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(expectedMarkdown));

    const result = await enrichIdea("my raw idea");

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
    const result = await enrichIdea("cool thought");
    expect(result.markdown).toBe(md);
    expect(result.model).toBe("omni-v2");
  });

  it("strips defensive code fences from LLM response", async () => {
    const inner = "---\nstatus: seedling\n---\n# Title\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse("```markdown\n" + inner + "```"));
    const result = await enrichIdea("fenced idea");
    expect(result.markdown).toBe(inner.trimEnd());
  });

  it("surfaces HTTP errors with response body in the message", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    await expect(enrichIdea("x")).rejects.toThrow("Invalid API key");
  });

  it("throws OmniRouteError with the HTTP status on a 4xx", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await enrichIdea("x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OmniRouteError);
    expect((caught as OmniRouteError).status).toBe(401);
    expect(isPermanentError(caught)).toBe(true);
  });

  it("throws OmniRouteError with status 0 on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    let caught: unknown;
    try {
      await enrichIdea("x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OmniRouteError);
    expect((caught as OmniRouteError).status).toBe(0);
    expect(isPermanentError(caught)).toBe(false);
    // A real network failure is transient (queue it), NOT a config problem.
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("throws a not-configured OmniRouteError when the URL is blank", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      omniRouteUrl: "",
    });
    let caught: unknown;
    try {
      await enrichIdea("x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OmniRouteError);
    // Status 0 like a network error, but flagged not-configured so callers
    // surface it instead of silently queuing for an endpoint that can't exist.
    expect((caught as OmniRouteError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(isPermanentError(caught)).toBe(false);
    expect((caught as OmniRouteError).message).toMatch(/not configured/i);
    // No fetch should even be attempted with a blank URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts Bearer tokens from network error messages", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await enrichIdea("x");
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
    await expect(enrichIdea("x")).rejects.toThrow("empty or malformed");
  });
});

// ── enrichJournal ─────────────────────────────────────────────────────────────

describe("enrichJournal", () => {
  it("POSTs with the journal prompt containing transcript", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\ndate: 2026-05-16\n---\n# Summary\n"),
    );
    await enrichJournal({ transcript: "today I met Alice", notes: "" });

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
    await enrichPerson({ ocrResult: "Jane Doe, CEO", context: "met at conference" });

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
    const result = await promoteIdea(currentMd, "developing");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildPromoteIdeaPrompt(currentMd, "developing");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(result.markdown).toBe(updatedMd);
  });
});

// ── HTTPS enforcement ─────────────────────────────────────────────────────────

describe("HTTPS enforcement", () => {
  it("rejects http:// URLs (non-localhost)", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      omniRouteUrl: "http://evil.example.com",
      omniRouteApiKey: "test-key",
      omniRouteModel: "gpt-4o-mini",
      omniRouteTranscriptionModel: "whisper-1",
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: false,
      captureFolderPath: "",
      promptOverrides: {},
    });
    await expect(enrichIdea("x")).rejects.toThrow(/https:\/\//);
    // Ensure no fetch was attempted
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http://localhost for dev", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      omniRouteUrl: "http://localhost:8080",
      omniRouteApiKey: "",
      omniRouteModel: "gpt-4o-mini",
      omniRouteTranscriptionModel: "whisper-1",
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: false,
      captureFolderPath: "",
      promptOverrides: {},
    });
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# x\n"),
    );
    await expect(enrichIdea("x")).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ── enrichSharedLink ──────────────────────────────────────────────────────────

describe("enrichSharedLink", () => {
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

    const result = await enrichSharedLink({
      url: "https://example.com/article",
      text: "",
      context: "",
    });

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

    const result = await enrichSharedLink({
      url: "https://offline.example.com/p",
      text: "",
      context: "",
    });

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

    await enrichSharedLink({
      url: "",
      text: "Some shared snippet of text without a URL.",
      context: "",
    });

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
    await enrichSharedLink({
      url: "https://example.com/cb",
      text: "",
      context: "",
      onPreviewSettled: settled,
    });

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("invokes onPreviewSettled even when the preview fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# y\n"),
    );

    const settled = vi.fn();
    await enrichSharedLink({
      url: "https://example.com/cb-fail",
      text: "",
      context: "",
      onPreviewSettled: settled,
    });

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

    await enrichSharedLink({
      url: "https://blank.example.com/",
      text: "",
      context: "",
    });

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
    const { getPromptOverrides } = await import("./settings");
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "You are an extremely terse summariser. Respond in one line.",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("the override should reach the API");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(
      "You are an extremely terse summariser. Respond in one line.",
    );
  });

  it("enrichIdea falls back to default when override is empty", async () => {
    const { getPromptOverrides } = await import("./settings");
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({ idea: "" });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("default path");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    // Default idea prompt contains its signature phrase
    expect(body.messages[0].content).toMatch(
      /Suggest 2-3 relevant tags|personal knowledge assistant/,
    );
  });

  it("enrichJournal applies the journal override, not the idea override", async () => {
    const { getPromptOverrides } = await import("./settings");
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "wrong",
      journal: "journal-custom",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichJournal({ transcript: "test", notes: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].content).toBe("journal-custom");
  });

  it("enrichSharedImage applies the sharedImage override via its inline splice", async () => {
    // sharedImage uses an inline splice (not withSystemOverride) because its
    // user content is OpenAIMessage[] not PromptPair — pin the inline path so
    // it can't drift from the helper-driven entry points silently.
    const { getPromptOverrides } = await import("./settings");
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      sharedImage: "shared-image-custom-system",
    });
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(
        "---\nkind: shared-image\n---\n# x\n\n## What's in this\nstuff\n",
      ),
    );

    const { enrichSharedImage } = await import("./omniroute");
    await enrichSharedImage({
      base64: "QkFTRTY0",
      mimeType: "image/jpeg",
      context: "test ctx",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("shared-image-custom-system");
    // User content stays multimodal (the image bytes still attach)
    expect(Array.isArray(body.messages[1].content)).toBe(true);
  });
});

// ── transcribeAudio ───────────────────────────────────────────────────────────

describe("transcribeAudio (on-device path)", () => {
  beforeEach(async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockReset();
  });

  it("returns the on-device transcript + 'on-device' model on the happy path", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

    const out = await transcribeAudio({
      base64: "AAAA",
      mimeType: "audio/mp4",
      filename: "clip.m4a",
    });

    expect(out.text).toBe("hello world");
    expect(out.model).toBe("on-device");
    // transcribeAudio forwards only base64 + filename; the mimeType is used
    // for the cap pre-check and not threaded into the on-device wrapper.
    expect(transcribeOnDevice).toHaveBeenCalledWith({
      base64: "AAAA",
      filename: "clip.m4a",
    });
  });

  it("propagates the on-device error through to the caller", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
      new Error("On-device STT error: no-speech — no speech detected"),
    );

    await expect(
      transcribeAudio({
        base64: "AAAA",
        mimeType: "audio/mp4",
        filename: "clip.m4a",
      }),
    ).rejects.toThrow(/no-speech/);
  });

  it("does not throw at exactly the 25 MB cap — invokes the on-device wrapper", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("ok");
    // floor(len * 0.75) === MAX_TRANSCRIPTION_BYTES — sits exactly on the cap,
    // which is allowed (the guard is strictly greater-than).
    const atCap = "A".repeat(Math.ceil(MAX_TRANSCRIPTION_BYTES / 0.75));

    const out = await transcribeAudio({
      base64: atCap,
      mimeType: "audio/mp4",
      filename: "atcap.m4a",
    });

    expect(out.text).toBe("ok");
    expect(transcribeOnDevice).toHaveBeenCalledTimes(1);
  });

  it("throws OmniRouteError 413 just over the cap, before calling the wrapper", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    // Two chars past the boundary → floor(len * 0.75) > MAX_TRANSCRIPTION_BYTES.
    const overCap = "A".repeat(Math.ceil(MAX_TRANSCRIPTION_BYTES / 0.75) + 2);

    try {
      await transcribeAudio({
        base64: overCap,
        mimeType: "audio/mp4",
        filename: "huge.m4a",
      });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OmniRouteError);
      expect((e as OmniRouteError).status).toBe(413);
      expect((e as OmniRouteError).message).toContain("transcription caps");
    }
    // Pre-flight short-circuits before invoking the wrapper.
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("MAX_TRANSCRIPTION_BYTES is 25 MB", () => {
    expect(MAX_TRANSCRIPTION_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ── autoTranscribeIfEnabled ───────────────────────────────────────────────────

describe("autoTranscribeIfEnabled", () => {
  const AUDIO_NOTE = `---\nkind: shared-audio\n---\n# Audio\n\n## File\n[clip.m4a](../Audio/clip.m4a)\n\n## Context\n(none)\n`;
  // Only the toggle differs from the default — derive it so a Settings
  // interface change updates one fixture (BASE_SETTINGS), not two.
  const SETTINGS_TOGGLE_ON = { ...BASE_SETTINGS, autoTranscribeOnSave: true };

  beforeEach(async () => {
    const { getSettings } = await import("./settings");
    const { readNote, readPairedBinaryFromNote, updateNote, upsertSection } =
      await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    // Reset + reseed getSettings so a queued mockResolvedValueOnce from a
    // prior test can't leak in (defense against order-dependence — the
    // toggle-on tests below queue one-shot overrides). Default: toggle OFF.
    vi.mocked(getSettings).mockReset();
    vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(readNote).mockReset();
    vi.mocked(readPairedBinaryFromNote).mockReset();
    vi.mocked(updateNote).mockReset();
    vi.mocked(transcribeOnDevice).mockReset();
    // mockClear (not mockReset) — keep upsertSection's format implementation,
    // just drop call history so per-test toHaveBeenCalledWith stays clean.
    vi.mocked(upsertSection).mockClear();
  });

  it("no-ops (returns null) when autoTranscribeOnSave is false", async () => {
    // Default global settings mock has autoTranscribeOnSave: false.
    const { readNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBeNull();
    // Short-circuits before reading the note OR hitting the recognizer.
    expect(readNote).not.toHaveBeenCalled();
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns null on the full happy path (read, transcribe, upsert, update)", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote, upsertSection } =
      await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBeNull();

    // Pin that the filename extracted by the ../Audio/ regex ("clip.m4a")
    // reaches the on-device wrapper, alongside the binary's base64.
    expect(transcribeOnDevice).toHaveBeenCalledWith({
      base64: "AAAA",
      filename: "clip.m4a",
    });
    // Pin what's forwarded to upsertSection: original note body, the
    // "Transcript" heading, the transcript text. (The "## Transcript"
    // substring asserted below comes from the MOCKED upsertSection's format
    // string — real section-insertion behavior is covered in writer.test.ts.)
    expect(upsertSection).toHaveBeenCalledWith(
      AUDIO_NOTE,
      "Transcript",
      "hello world",
    );
    expect(updateNote).toHaveBeenCalledTimes(1);
    const [filepath, newBody] = vi.mocked(updateNote).mock.calls[0];
    expect(filepath).toBe("/vault/Ideas/foo.md");
    expect(newBody).toContain("## Transcript");
    expect(newBody).toContain("hello world");
  });

  it("returns 'Note has no Audio/ link' when body doesn't reference Audio/", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(
      `---\nkind: idea\n---\n# Plain idea\n\nNo binary link here.\n`,
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBe("Note has no Audio/ link");
    expect(readPairedBinaryFromNote).not.toHaveBeenCalled();
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns the readNote error message when reading the note throws", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockRejectedValueOnce(
      new Error("ENOENT: no such file"),
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/gone.md");
    expect(result).toContain("ENOENT");
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns the transcribeAudio error message when the on-device recognizer fails", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote } = await import(
      "./writer"
    );
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
      new Error("On-device STT error: no-speech — no speech detected"),
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toContain("no-speech");
    // updateNote MUST NOT run on transcribe failure — the original note
    // stays untouched.
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("never throws — returns an error string even when updateNote rejects", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote } = await import(
      "./writer"
    );
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("ok");
    vi.mocked(updateNote).mockRejectedValueOnce(
      new Error("SAF tree permission revoked"),
    );

    // .resolves asserts the helper does NOT throw AND returns the error
    // string in one idiomatic line — and preserves the failure if it ever
    // does throw (the old manual try/catch swallowed the stack).
    await expect(
      autoTranscribeIfEnabled("/vault/Ideas/foo.md"),
    ).resolves.toContain("SAF tree permission revoked");
  });
});
