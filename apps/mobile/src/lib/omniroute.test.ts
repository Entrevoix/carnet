import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock settings ─────────────────────────────────────────────────────────────
vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "https://llm.example.com",
    omniRouteApiKey: "test-key",
    omniRouteModel: "gpt-4o-mini",
    omniRouteTranscriptionModel: "gemini/gemini-2.5-flash-lite",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    captureFolderPath: "",
    promptOverrides: {},
  }),
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
  promoteIdea,
  OmniRouteError,
  isPermanentError,
  assertBase64UnderLimit,
  MAX_SHARED_IMAGE_BYTES,
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

// ── transcribeAudio + autoTranscribeIfEnabled ───────────────────────────────
//
// TODO: tests for the on-device transcription path. The prior chat-completion
// tests were stripped when transcribeAudio swapped from OmniRoute to
// expo-speech-recognition (Gemini's content-policy filter was refusing
// verbatim transcription requests). Re-add by mocking
// './audioTranscribeOnDevice' via vi.mock and asserting on the same
// behaviors (cap check, happy path, error surfacing in
// autoTranscribeIfEnabled, never-throws contract).
//
// The MAX_TRANSCRIPTION_BYTES export is exercised indirectly through the
// cap check that still lives in transcribeAudio; no separate unit test
// needed for the constant.
