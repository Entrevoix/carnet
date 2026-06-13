import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock settings ─────────────────────────────────────────────────────────────
// BASE_SETTINGS is the default getSettings() shape with Karakeep configured.
// Hoisted via vi.hoisted so it can be referenced inside the vi.mock factory
// (which vitest hoists above module scope) and by per-test overrides.
const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    omniRouteUrl: "https://llm.example.com",
    omniRouteApiKey: "omni-key",
    omniRouteModel: "gpt-4o-mini",
    omniRouteTranscriptionModel: "gemini/gemini-2.5-flash-lite",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "https://karakeep.example.com",
    karakeepApiKey: "kk-secret-token-xyz123",
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
}));

// ── Mock fetch ────────────────────────────────────────────────────────────────
function makeOkResponse(json: unknown, status = 201): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  const body = JSON.stringify({ error: message });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  createTextBookmark,
  attachTags,
  KarakeepError,
  isNotConfiguredError,
} from "./karakeep";

interface CreateBody {
  type: string;
  text: string;
  title?: string;
  createdAt?: string;
}

interface TagsBody {
  tags: Array<{ tagName: string; attachedBy: string }>;
}

beforeEach(() => {
  fetchMock.mockReset();
});

// ── createTextBookmark ────────────────────────────────────────────────────────

describe("createTextBookmark", () => {
  it("POSTs to /api/v1/bookmarks with Bearer auth and a text body, returns the id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_123" }));

    const result = await createTextBookmark({
      text: "# My Idea\n\nbody",
      title: "My Idea",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.type).toBe("text");
    expect(body.text).toBe("# My Idea\n\nbody");
    expect(body.title).toBe("My Idea");

    expect(result).toEqual({ id: "bk_123" });
  });

  it("omits title and createdAt from the body when not provided", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_456" }));

    await createTextBookmark({ text: "raw text" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.type).toBe("text");
    expect(body.text).toBe("raw text");
    expect("title" in body).toBe(false);
    expect("createdAt" in body).toBe(false);
  });

  it("includes createdAt in the body when provided", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_789" }));

    await createTextBookmark({
      text: "x",
      createdAt: "2026-06-12T10:00:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.createdAt).toBe("2026-06-12T10:00:00.000Z");
  });

  it("trims trailing slashes from the configured URL", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "https://karakeep.example.com///",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_1" }));

    await createTextBookmark({ text: "x" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks");
  });

  it("accepts a 200 status as success", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_200" }, 200));
    const result = await createTextBookmark({ text: "x" });
    expect(result.id).toBe("bk_200");
  });

  it("throws a not-configured KarakeepError when the URL is blank, without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "",
    });
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect((caught as KarakeepError).message).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a KarakeepError with the HTTP status on a 4xx (e.g. 401)", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(401);
    expect((caught as KarakeepError).message).toContain("Invalid API key");
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("throws a KarakeepError with status 0 on a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("never leaks the api key in a thrown network error message (sanitize)", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer kk-secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("kk-secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });

  it("throws when the response has no string id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ notId: true }));
    await expect(createTextBookmark({ text: "x" })).rejects.toThrow(
      /malformed bookmark/i,
    );
  });

  it("rejects non-https URLs (non-localhost) without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://evil.example.com",
    });
    await expect(createTextBookmark({ text: "x" })).rejects.toThrow(
      /https:\/\//,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http://localhost for dev", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://localhost:3000",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_local" }));
    await expect(createTextBookmark({ text: "x" })).resolves.toEqual({
      id: "bk_local",
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/bookmarks");
  });
});

// ── attachTags ────────────────────────────────────────────────────────────────

describe("attachTags", () => {
  it("POSTs to /api/v1/bookmarks/{id}/tags with the correct body shape", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ attached: [] }, 200));

    await attachTags("bk_123", ["idea", "ml"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://karakeep.example.com/api/v1/bookmarks/bk_123/tags",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );

    const body = JSON.parse(init.body as string) as TagsBody;
    expect(body.tags).toEqual([
      { tagName: "idea", attachedBy: "human" },
      { tagName: "ml", attachedBy: "human" },
    ]);
  });

  it("does not call fetch when the tag list is empty", async () => {
    await attachTags("bk_123", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a KarakeepError on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, "Bookmark not found"));
    let caught: unknown;
    try {
      await attachTags("bk_missing", ["idea"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(404);
  });
});
