import { beforeEach, describe, expect, it, vi } from "vitest";

const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    omniRouteVisionModel: "",
    llmBackend: "local" as const,
    localLlmUrl: "http://127.0.0.1:8080",
    localLlmModel: "test-local-model",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: false,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
}));

function makeOkResponse(markdown: string, model = "test-local-model"): Response {
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
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  enrichIdea,
  ocrCardViaVision,
  listModels,
  healthCheck,
  LocalLlmError,
  isPermanentError,
  isNotConfiguredError,
} from "./localLlm";
import { getSettings } from "./settings";

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
});

describe("localLlm.enrichIdea", () => {
  it("posts to the configured base URL's /v1/chat/completions with no Authorization header when no API key is set", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });

  it("sends an Authorization header when a local-LLM API key is configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      localLlmApiKey: "local-secret",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local-secret");
  });

  it("defaults to http://127.0.0.1:8080 when localLlmUrl is blank, rather than throwing not-configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...BASE_SETTINGS, localLlmUrl: "" });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("classifies a 4xx response as a permanent LocalLlmError", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, "bad request"));

    const err = await enrichIdea("doomed").then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LocalLlmError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

describe("localLlm.ocrCardViaVision", () => {
  it("uses the single configured model (no separate vision model)", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\njane@example.com"));

    const result = await ocrCardViaVision({ base64: "abc123", mimeType: "image/jpeg" });

    expect(result.text).toBe("Jane Doe\nCEO\njane@example.com");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });
});

describe("localLlm.listModels", () => {
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

describe("localLlm.healthCheck", () => {
  it("returns true when /health responds ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/health");
  });

  it("returns false when /health is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(false);
  });

  it("returns false when /health responds non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(false);
  });
});
