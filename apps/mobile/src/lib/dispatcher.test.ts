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
