import { beforeEach, describe, expect, it, vi } from "vitest";

// ── LLM provider list Phase 1: dispatcher.ts no longer swaps between two
// whole client modules (omniroute.ts / localLlm.ts) — both were merged into
// ONE llmClient.ts, parameterized by a ProviderConfig dispatcher.ts resolves
// from settings. So these tests exercise the REAL llmClient.ts (unmocked)
// against a mocked global fetch, and verify "did the dispatcher route to the
// right backend" via the resulting HTTP request (URL + model) rather than via
// module-identity/call-count assertions — there's no second module left to
// assert "was NOT called" against.
//
// transcribeAudio/autoTranscribeIfEnabled now live directly in dispatcher.ts
// (they read settings + touch the vault writer, outside llmClient.ts's "reads
// no settings" contract) — their retargeted tests (moved from
// omniroute.test.ts) live here too.

const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    llmProviders: [
      {
        id: "omniroute",
        label: "OmniRoute",
        baseUrl: "https://llm.example.com",
        model: "gpt-4o-mini",
        visionModel: "vision-model-xyz",
        preset: "omniroute",
      },
      {
        id: "relais",
        label: "Relais (local)",
        baseUrl: "http://127.0.0.1:8080",
        model: "",
        visionModel: "",
        preset: "relais",
      },
    ],
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "test-key",
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
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
}));

// providerKeys.ts is the real per-provider SecureStore lookup — mocked here
// so this suite doesn't need a native SecureStore shim. Routes the two known
// ids to BASE_SETTINGS' key fields; anything else gets "" (no custom-provider
// key tests in this file).
vi.mock("./providerKeys", () => ({
  getKey: vi.fn(async (id: string) => {
    if (id === "omniroute") return BASE_SETTINGS.omniRouteApiKey;
    if (id === "relais") return BASE_SETTINGS.localLlmApiKey;
    return "";
  }),
  setKey: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("./writer", () => ({
  readNote: vi.fn(),
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(),
  upsertSection: vi.fn(
    (md: string, heading: string, body: string) =>
      `${md}\n\n## ${heading}\n\n${body}\n`,
  ),
}));

vi.mock("./audioTranscribeOnDevice", () => ({
  transcribeOnDevice: vi.fn(),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  enrichIdea,
  enhanceProse,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  promoteIdea,
  isPermanentError,
  isNotConfiguredError,
  transcribeAudio,
  autoTranscribeIfEnabled,
  MAX_TRANSCRIPTION_BYTES,
  FALLBACK_PROVIDER_FIELD,
} from "./dispatcher";
import * as llmClient from "./llmClient";
import { getSettings, getPromptOverrides } from "./settings";

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

// ── Required test 1 + 2: the dispatcher resolves the right ProviderConfig per
// backend and reaches the real llmClient.ts with it — the load-bearing "zero
// behavior change" guarantee for existing users, now verified via the actual
// HTTP request rather than via a second module's call count.

describe("enhanceProse routing", () => {
  it("uses the active provider when no enhanceProviderId is set", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("routes to enhanceProviderId's entry OVER the active one", async () => {
    // The test that proves "a better llm" actually takes effect. The active
    // entry has a perfectly good text model; the Enhance entry must still win.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "big-local-model" }
          : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    const outcome = await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("big-local-model");
    expect(outcome.providerLabel).toBe("Relais (local)");
  });

  it("falls back to the active entry when enhanceProviderId is stale", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceProviderId: "custom-deleted",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("sends enhanceModel instead of the provider's own model", async () => {
    // The point of the feature: same endpoint, stronger model. Captures keep
    // running on gpt-4o-mini; Enhance overrides just the model string.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "anthropic/claude-sonnet-5",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-5");
  });

  it("treats a whitespace-only enhanceModel as unset", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "   ",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("does NOT force enhanceModel onto the fallback provider", async () => {
    // A model id only exists on the endpoint that listed it. Carrying a
    // Sonnet id onto the local Relais fallback would turn a recoverable
    // network blip into a hard "model not found".
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "anthropic/claude-sonnet-5",
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    // Primary attempt fails in the unreachable class, triggering the retry.
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const primary = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    const fallback = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(primary.model).toBe("anthropic/claude-sonnet-5");
    expect(fallback.model).toBe("local-small");
  });

  it("keeps the PRIMARY error when the fallback is merely unconfigured", async () => {
    // Observed on-device 2026-08-05: OmniRoute timed out on a slow reasoning
    // model, the chain retried an unconfigured Relais, and the user was told
    // "Local LLM model not configured — set it in Settings". That names the
    // wrong provider and hides the real fault, so the primary error must win.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais", // relais has model: "" -> not configured
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await expect(enhanceProse("rough prose")).rejects.toThrow(/Network request failed/);
    // The fallback never got as far as a request — it failed on config.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a fallback error when the fallback genuinely tried", async () => {
    // A configured fallback that actually attempted and failed reflects a real
    // second attempt, so its error is the honest one to show.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "fallback key rejected"));

    await expect(enhanceProse("rough prose")).rejects.toThrow(/fallback key rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns prose with NO frontmatter marker spliced into it", async () => {
    // enhanceProse is the one entry point that must skip withFallbackMarker:
    // the result is bare prose, so a marker would prepend a stray `---` block
    // into the note body. lib/enhanceProse.ts stamps AFTER re-attaching the
    // real frontmatter instead.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    const outcome = await enhanceProse("rough prose");

    expect(outcome.result.markdown).not.toContain("---");
    expect(outcome.result.markdown).toContain("polished prose");
  });
});

describe("dispatcher backend routing", () => {
  it("routes to the OmniRoute config when llmBackend is 'omniroute' (the default)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("route to omniroute");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("routes to the local-LLM config when llmBackend is 'local'", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "local-model" }
          : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("# from local\n", "local-model"),
    );

    const result = await enrichIdea("route to local");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("local-model");
    // The user's text must actually be forwarded, not just the URL/model —
    // the OmniRoute routing test asserts the equivalent via
    // body.messages.at(-1)?.content in the "online path" describe below;
    // this restores the same check for the local backend.
    expect(body.messages.at(-1)?.content).toContain("route to local");
    expect(result.markdown).toBe("# from local\n");
  });

  it("defaults the local backend's blank URL to the loopback address", async () => {
    // localLlmUrl blank is a valid, expected state for the local backend
    // (zero-setup disconnected flow) — unlike OmniRoute's blank URL, which is
    // not-configured. This defaulting now lives in dispatcher.ts's
    // buildConfig (it used to live in localLlm.ts's getBaseUrl()).
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, baseUrl: "", model: "local-model" } : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# from local\n"));

    await enrichIdea("blank local url");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
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

  it("produces an identical request whether called via the dispatcher or llmClient directly with the equivalent config", async () => {
    // Fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeOkResponse("# Same\n\nbody\n")),
    );

    await enrichIdea("parity check");
    const [dispUrl, dispInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    fetchMock.mockClear();
    const omniroute = BASE_SETTINGS.llmProviders.find((p) => p.id === "omniroute")!;
    await llmClient.enrichIdea("parity check", {
      baseUrl: omniroute.baseUrl,
      apiKey: BASE_SETTINGS.omniRouteApiKey,
      model: omniroute.model,
      visionModel: omniroute.visionModel,
      label: "OmniRoute",
    });
    const [directUrl, directInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Compare the request essentials — URL, method, headers, and body. The
    // per-call AbortSignal instance differs by design, so it's excluded.
    expect(dispUrl).toBe(directUrl);
    expect(dispInit.method).toBe(directInit.method);
    expect(dispInit.headers).toEqual(directInit.headers);
    expect(dispInit.body).toBe(directInit.body);
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

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });

  it("classifies a blank-URL failure through the dispatcher as not-configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, baseUrl: "" } : p,
      ),
    });

    const err = await enrichIdea("no url set").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
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

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
    expect(isPermanentError(err)).toBe(false);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

// ── dispatcher forwards the CORRECT per-mode prompt override ─────────────────
// Pre-merge, omniroute.test.ts mocked getPromptOverrides and asserted the
// override reached body.messages[0].content directly inside omniroute.ts.
// That responsibility moved into dispatcher.ts's buildConfig/overrides
// plumbing (llmClient.ts now only proves it uses whatever override string
// it's handed as an argument — see llmClient.test.ts's "enrich entry points
// honor prompt overrides"). These tests close the gap: a dispatcher that
// forwarded the WRONG override field (e.g. overrides.journal into
// enrichIdea) or dropped the argument entirely would pass every other test
// in this suite. Each override string below is distinct so a mismatched
// wire-up fails loudly rather than by coincidence.

describe("dispatcher forwards the correct per-mode prompt override", () => {
  it("enrichIdea forwards overrides.idea", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-7f3a",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("text");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-IDEA-7f3a");
  });

  it("enrichJournal forwards overrides.journal", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      journal: "OVERRIDE-JOURNAL-9c1d",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichJournal({ transcript: "t", notes: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-JOURNAL-9c1d");
  });

  it("enrichPerson forwards overrides.person", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      person: "OVERRIDE-PERSON-2e8b",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichPerson({ ocrResult: "Jane Doe", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-PERSON-2e8b");
  });

  it("enrichSharedImage forwards overrides.sharedImage", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      sharedImage: "OVERRIDE-SHAREDIMAGE-4b6f",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-SHAREDIMAGE-4b6f");
  });

  it("enrichSharedLink forwards overrides.sharedLink", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      sharedLink: "OVERRIDE-SHAREDLINK-5d0a",
    });
    // url: "" skips the preview fetch entirely (text-only share) — keeps
    // this test to a single fetch call, matching the pattern already used
    // elsewhere for the no-preview path.
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedLink({ url: "", text: "some shared text", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-SHAREDLINK-5d0a");
  });

  it("promoteIdea applies NO override — the current, correct behaviour", async () => {
    // Even with every override field populated, promoteIdea must never read
    // any of them: dispatcher.ts's promoteIdea only calls getSettings(), not
    // getPromptOverrides() — matching omniroute.ts's original promoteIdea,
    // which never threaded prompt overrides either.
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-7f3a",
      journal: "OVERRIDE-JOURNAL-9c1d",
      person: "OVERRIDE-PERSON-2e8b",
      sharedImage: "OVERRIDE-SHAREDIMAGE-4b6f",
      sharedLink: "OVERRIDE-SHAREDLINK-5d0a",
    });
    const currentMd = "---\nstatus: seedling\n---\n# My Idea\n\nRaw thought.\n";
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: developing\n---\n# My Idea\n\nMore.\n"),
    );

    await promoteIdea(currentMd, "developing");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).not.toContain("OVERRIDE-");
  });
});

// ── transcribeAudio (on-device path) — moved from omniroute.test.ts. Lives in
// dispatcher.ts now (backend-agnostic on-device speech recognition, not part
// of the llmClient.ts OpenAI-compatible client).

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

  it("throws an LlmClientError 413 just over the cap, before calling the wrapper", async () => {
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
      expect(e).toBeInstanceOf(llmClient.LlmClientError);
      expect((e as llmClient.LlmClientError).status).toBe(413);
      expect((e as llmClient.LlmClientError).message).toContain("transcription caps");
    }
    // Pre-flight short-circuits before invoking the wrapper.
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("MAX_TRANSCRIPTION_BYTES is 25 MB", () => {
    expect(MAX_TRANSCRIPTION_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ── autoTranscribeIfEnabled — moved from omniroute.test.ts alongside
// transcribeAudio.

describe("autoTranscribeIfEnabled", () => {
  const AUDIO_NOTE = `---\nkind: shared-audio\n---\n# Audio\n\n## File\n[clip.m4a](../Audio/clip.m4a)\n\n## Context\n(none)\n`;
  // Only the toggle differs from the default — derive it so a Settings
  // interface change updates one fixture (BASE_SETTINGS), not two.
  const SETTINGS_TOGGLE_ON = { ...BASE_SETTINGS, autoTranscribeOnSave: true };

  beforeEach(async () => {
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

// ── Phase 3: the offline fallback chain (see the design doc's "Offline
// fallback"). PLAIN_MARKDOWN carries no frontmatter block at all, so
// sanitizeAndNormalize (enrichSanitize.ts) bails out (no header to
// normalize) and llmClient.ts falls through to sanitizeMarkdown, which is a
// no-op on threat-free plain text — that is what makes byte-for-byte
// equality assertions meaningful here rather than fighting frontmatter
// canonicalization noise unrelated to this phase.
describe("offline fallback chain (Phase 3)", () => {
  const PLAIN_MARKDOWN = "# Idea\n\nSome idea body, no frontmatter at all.\n";
  const NETWORK_ERROR = new TypeError("Network request failed");

  function withFallback(id: string | null) {
    return {
      ...BASE_SETTINGS,
      fallbackProviderId: id,
      // BASE_SETTINGS' relais entry has a blank model (it's not used as a
      // fallback target elsewhere in this file) — give it one here so a
      // relais fallback attempt reaches the network instead of failing
      // its OWN not-configured check, which would confound these tests.
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-fallback-model" } : p,
      ),
    };
  }

  it("retries the fallback once when the primary is unreachable", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    const result = await enrichIdea("primary unreachable");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe("https://llm.example.com/v1/chat/completions");
    expect(secondUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");
    // Marker present, value = fallback provider id, rest of the markdown
    // byte-identical to what the fallback returned.
    expect(result.markdown).toBe(
      `---\n${FALLBACK_PROVIDER_FIELD}: relais\n---\n${PLAIN_MARKDOWN}`,
    );
  });

  it("does NOT retry on a permanent 4xx from the primary", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "bad api key"));

    await expect(enrichIdea("bad primary key")).rejects.toSatisfy(
      (e: unknown) => isPermanentError(e),
    );
    // A retry against the fallback here would mask the bad key by possibly
    // succeeding against a different (e.g. local, unauthenticated) model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates when both the primary and the fallback are unreachable", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("both unreachable")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("behaves exactly as today when no fallback is configured", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback(null));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("no fallback configured")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when fallbackProviderId names the same provider as the primary", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("omniroute"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("fallback equals primary")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the PRIMARY is not-configured (blank URL) — a configuration problem, not a reachability one", async () => {
    // Critical: the fallback (relais) here is a FULLY VALID, reachable
    // config (withFallback() gives it a real model + the loopback default
    // URL) — if shouldRetryWithFallback's not-configured guard were
    // missing, this retry would actually succeed against it, and the
    // assertions below (zero fetch calls, a not-configured rejection) would
    // both flip. A relais entry that was ALSO not-configured would let this
    // test pass for the wrong reason regardless of the guard.
    const settings = withFallback("relais");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...settings,
      llmProviders: settings.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, baseUrl: "" } : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    await expect(enrichIdea("blank primary url")).rejects.toSatisfy(
      (e: unknown) => isNotConfiguredError(e),
    );
    // Never even reaches the network — assertUrlConfigured throws
    // synchronously before any fetch, and no retry against the (otherwise
    // perfectly reachable) fallback is attempted.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("leaves the primary-path markdown completely byte-identical (no marker)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    const result = await enrichIdea("primary succeeds, no fallback used");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe(PLAIN_MARKDOWN);
    expect(result.markdown).not.toContain(FALLBACK_PROVIDER_FIELD);
  });
});

// ── Phase 3: vision routing rung (see the design doc's "Vision routing").
// enrichSharedImage is the representative call site here — ocrCardViaVision
// shares the same resolveVisionProviderId() helper in dispatcher.ts.
describe("vision routing (Phase 3)", () => {
  it("prefers the active entry's own vision model (today's behavior, unchanged)", async () => {
    // BASE_SETTINGS' omniroute entry already has visionModel set — the
    // common case, and the one every OTHER test in this file relies on.
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("vision-model-xyz");
  });

  it("falls back to visionProviderId's entry when the active entry has no vision model", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      visionProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) => {
        if (p.id === "omniroute") return { ...p, visionModel: "" };
        if (p.id === "relais") {
          return { ...p, baseUrl: "http://192.168.1.9:8080", model: "vision-capable-local" };
        }
        return p;
      }),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://192.168.1.9:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("vision-capable-local");
  });

  it("throws the existing not-configured error (no new failure mode) when neither the active entry nor visionProviderId has a vision model", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      visionProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, visionModel: "" } : p,
      ),
      // relais keeps its BASE_SETTINGS visionModel/model, both "" — no
      // vision capability there either.
    });

    await expect(
      enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" }),
    ).rejects.toSatisfy((e: unknown) => isNotConfiguredError(e));
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
