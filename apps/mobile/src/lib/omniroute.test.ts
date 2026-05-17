import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock settings ─────────────────────────────────────────────────────────────
vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "https://llm.example.com",
    omniRouteApiKey: "test-key",
    omniRouteModel: "gpt-4o-mini",
    captureFolderPath: "",
  }),
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
  promoteIdea,
  OmniRouteError,
  isPermanentError,
} from "./omniroute";
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

beforeEach(() => {
  fetchMock.mockReset();
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
      captureFolderPath: "",
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
      captureFolderPath: "",
    });
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# x\n"),
    );
    await expect(enrichIdea("x")).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
