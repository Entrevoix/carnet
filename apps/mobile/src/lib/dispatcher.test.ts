import { beforeEach, describe, expect, it, vi } from "vitest";

// ── B7 Phase 1: the dispatcher is a re-export seam over the OmniRoute backend.
// These tests prove that reaching the six enrich functions + the two error
// predicates THROUGH the dispatcher is byte-identical to importing ./omniroute
// directly — the load-bearing "zero behavior change" guarantee for existing
// users. Mock surface mirrors omniroute.test.ts (settings, writer, the
// on-device transcription wrapper, and global fetch), because the dispatcher
// imports omniroute, which imports those.

const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    omniRouteUrl: "https://llm.example.com",
    omniRouteApiKey: "test-key",
    omniRouteModel: "gpt-4o-mini",
    omniRouteVisionModel: "vision-model-xyz",
    llmBackend: "omniroute" as const,
    localLlmUrl: "",
    localLlmModel: "",
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

vi.mock("./writer", () => ({
  readNote: vi.fn(),
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(),
  upsertSection: vi.fn(),
}));

vi.mock("./audioTranscribeOnDevice", () => ({
  transcribeOnDevice: vi.fn(),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

// Import BOTH modules — the dispatcher (system under test) and the concrete
// backend it wraps — so we can assert reference identity and request parity.
import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  promoteIdea,
  isPermanentError,
  isNotConfiguredError,
} from "./dispatcher";
import * as omniroute from "./omniroute";
import { OmniRouteError } from "./omniroute";
import { getSettings } from "./settings";

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
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
});

// ── Required test 1 + 2: the dispatcher routes online + drain paths identically
// to a direct omniroute call. The six enrich functions and the two predicates
// exported by the dispatcher are the SAME references omniroute exports — so
// whatever the online capture screens and the offline drain (queue.ts) invoke
// through the dispatcher is literally the omniroute implementation.

describe("dispatcher re-export identity (online + drain parity)", () => {
  it("re-exports the exact same six enrich functions as omniroute", () => {
    expect(enrichIdea).toBe(omniroute.enrichIdea);
    expect(enrichJournal).toBe(omniroute.enrichJournal);
    expect(enrichPerson).toBe(omniroute.enrichPerson);
    expect(enrichSharedImage).toBe(omniroute.enrichSharedImage);
    expect(enrichSharedLink).toBe(omniroute.enrichSharedLink);
    expect(promoteIdea).toBe(omniroute.promoteIdea);
  });

  it("re-exports the exact same error predicates as omniroute", () => {
    expect(isPermanentError).toBe(omniroute.isPermanentError);
    expect(isNotConfiguredError).toBe(omniroute.isNotConfiguredError);
  });
});

describe("dispatcher online path (enrichIdea) hits the same HTTP request", () => {
  it("posts to /v1/chat/completions with the configured model + user text", async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought via the dispatcher");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.messages.at(-1)?.content).toContain(
      "a raw thought via the dispatcher",
    );
  });

  it("produces an identical request whether called via the dispatcher or omniroute directly", async () => {
    // Fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeOkResponse("# Same\n\nbody\n")),
    );

    await enrichIdea("parity check");
    const [dispUrl, dispInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    fetchMock.mockClear();
    await omniroute.enrichIdea("parity check");
    const [omniUrl, omniInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Compare the request essentials — URL, method, headers, and body. The
    // per-call AbortSignal instance differs by design, so it's excluded.
    expect(dispUrl).toBe(omniUrl);
    expect(dispInit.method).toBe(omniInit.method);
    expect(dispInit.headers).toEqual(omniInit.headers);
    expect(dispInit.body).toBe(omniInit.body);
  });
});

// ── Required test 3: the error predicates still correctly classify errors that
// flow through the dispatcher — a permanent (4xx) failure and a not-configured
// (blank URL) failure, both surfaced via a dispatcher enrich call.

describe("dispatcher preserves error classification", () => {
  it("classifies a 4xx from a dispatcher enrich call as permanent", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(401, "Unauthorized"));

    const err = await enrichIdea("doomed").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(OmniRouteError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });

  it("classifies a blank-URL failure through the dispatcher as not-configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      omniRouteUrl: "",
    });

    const err = await enrichIdea("no url set").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(OmniRouteError);
    expect(isNotConfiguredError(err)).toBe(true);
    // A not-configured failure is NOT a permanent 4xx — the drain must break
    // and wait rather than burn retries.
    expect(isPermanentError(err)).toBe(false);
    // No HTTP request should have been attempted with a blank URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a transient network failure through the dispatcher as neither permanent nor not-configured", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    const err = await enrichIdea("blip").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(OmniRouteError);
    expect(isPermanentError(err)).toBe(false);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});
