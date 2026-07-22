import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage + SecureStore mocks — same pattern as
// storage.test.ts. The real native bindings can't load under Node + vitest.
const _async = new Map<string, string>();
const _secure = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _async.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _async.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _async.delete(k);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => _secure.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    _secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    _secure.delete(k);
  }),
}));

import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  getSettings,
  hasLocalLlmApiKey,
  saveSettings,
  setLocalLlmApiKey,
  type Settings,
} from "./settings";

const SETTINGS_KEY = "carnet:settings:v2";

beforeEach(() => {
  _async.clear();
  _secure.clear();
});

// ── Required test 6: old blob without previewBeforeSave defaults to save-first ─

describe("previewBeforeSave default merge", () => {
  it("defaults to false (save-first) when no settings blob exists", async () => {
    const s = await getSettings();
    expect(s.previewBeforeSave).toBe(false);
  });

  it("defaults an old v2 blob missing the key to false without crashing (test 6)", async () => {
    // Simulate a settings blob persisted before this branch added the field.
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://example.com",
        omniRouteModel: "some-model",
        omniRouteTranscriptionModel: "whisper-1",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no previewBeforeSave key
      }),
    );
    const s = await getSettings();
    expect(s.previewBeforeSave).toBe(false);
    // The rest of the blob still loaded — no crash / no reset to defaults.
    expect(s.omniRouteUrl).toBe("https://example.com");
  });

  it("round-trips a previewBeforeSave=true opt-in through save + load", async () => {
    const base = await getSettings();
    const next: Settings = { ...base, previewBeforeSave: true };
    await saveSettings(next);
    const reloaded = await getSettings();
    expect(reloaded.previewBeforeSave).toBe(true);
  });
});

// ── Required test 5: Person/Journal capture never reads previewBeforeSave ─────
// Structural invariant on CaptureScreen: every reference to `previewBeforeSave`
// (state decl, settings load, and the Idea branch) appears BEFORE the Journal
// branch, so the Journal and Person submit branches cannot consult it. If a
// future edit wired the flag into Journal/Person, this fails loudly.

describe("Person + Journal ignore previewBeforeSave", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../screens/CaptureScreen.tsx", import.meta.url).href),
    "utf8",
  );

  it("does not reference previewBeforeSave in the Journal submit branch or after", () => {
    // The submit() journal branch is the brace form `if (mode === "journal") {`
    // (canSubmit uses the braceless `... ) return`, so this pins the branch).
    const journalSubmit = source.indexOf('if (mode === "journal") {');
    expect(journalSubmit).toBeGreaterThanOrEqual(0);
    const fromJournalOnward = source.slice(journalSubmit);
    // Everything from the Journal branch through the Person branch to EOF must
    // be free of the flag — only Idea consults it.
    expect(fromJournalOnward.includes("previewBeforeSave")).toBe(false);
  });

  it("does not reference previewBeforeSave anywhere near the person branch", () => {
    const personBranch = source.indexOf('// mode === "person"');
    expect(personBranch).toBeGreaterThanOrEqual(0);
    const afterPerson = source.slice(personBranch);
    expect(afterPerson.includes("previewBeforeSave")).toBe(false);
  });
});

// ── B7: old blob without llmBackend defaults to "omniroute" ──────────────────

describe("llmBackend default merge (B7 dispatcher)", () => {
  it("defaults to omniroute when no settings blob exists", async () => {
    const s = await getSettings();
    expect(s.llmBackend).toBe("omniroute");
  });

  it("defaults an old blob missing llmBackend to omniroute without crashing", async () => {
    // A settings blob persisted before B7 added the field (mirrors the real
    // upgrade shape — post-B1/B4 keys present, llmBackend absent).
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        omniRouteVisionModel: "claude/claude-sonnet-4-6",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no llmBackend key
      }),
    );

    const s = await getSettings();
    expect(s.llmBackend).toBe("omniroute");
    // The rest of the blob still loaded — no crash / no reset to defaults.
    expect(s.omniRouteUrl).toBe("https://llm.example.com");
    expect(s.omniRouteVisionModel).toBe("claude/claude-sonnet-4-6");
  });

  it("round-trips llmBackend through save + load", async () => {
    const base = await getSettings();
    await saveSettings({ ...base, llmBackend: "omniroute" });
    const persisted = JSON.parse(_async.get(SETTINGS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.llmBackend).toBe("omniroute");
    const reloaded = await getSettings();
    expect(reloaded.llmBackend).toBe("omniroute");
  });
});

describe("getSettings — persisted-blob migration (B1 vision model split)", () => {
  it("loads a pre-B1 blob (transcription-model key, no vision-model key) without crashing and defaults the vision model", async () => {
    // Exactly the shape a user upgrading from the pre-B1 build has on disk:
    // the vestigial transcription key is present, the new vision key is not.
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        omniRouteTranscriptionModel: "whisper-1",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const settings = await getSettings();

    // No crash; the user's real settings survive.
    expect(settings.omniRouteUrl).toBe("https://llm.example.com");
    expect(settings.omniRouteModel).toBe("gpt-4o-mini");
    // The new vision field is absent from the old blob → sensible default,
    // never undefined (a bare `.trim()` on undefined would throw downstream).
    expect(settings.omniRouteVisionModel).toBe(DEFAULT_VISION_MODEL);
    // The stale transcription key is not exposed on the Settings surface.
    expect(
      (settings as unknown as Record<string, unknown>)
        .omniRouteTranscriptionModel,
    ).toBeUndefined();
  });

  it("preserves an explicit vision model from a post-B1 blob", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        omniRouteVisionModel: "claude/claude-sonnet-4-6",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const settings = await getSettings();
    expect(settings.omniRouteVisionModel).toBe("claude/claude-sonnet-4-6");
  });

  it("returns defaults (incl. vision model) when there is no persisted blob", async () => {
    const settings = await getSettings();
    expect(settings.omniRouteModel).toBe(DEFAULT_OMNIROUTE_MODEL);
    expect(settings.omniRouteVisionModel).toBe(DEFAULT_VISION_MODEL);
  });

  it("round-trips the vision model through saveSettings → getSettings and drops the stale transcription key", async () => {
    // Seed a stale blob, then save over it; the persisted shape must no
    // longer carry omniRouteTranscriptionModel.
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({ omniRouteTranscriptionModel: "whisper-1" }),
    );

    const next: Settings = {
      omniRouteUrl: "https://llm.example.com",
      omniRouteApiKey: "",
      omniRouteModel: "gpt-4o-mini",
      omniRouteVisionModel: "gemini/gemini-2.5-flash",
      llmBackend: "omniroute",
      localLlmUrl: "",
      localLlmModel: "",
      localLlmApiKey: "",
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: false,
      richEditorEnabled: true,
      captureFolderPath: "",
      promptOverrides: {},
      karakeepUrl: "",
      karakeepApiKey: "",
      previewBeforeSave: false,
    };
    await saveSettings(next);

    const persisted = JSON.parse(_async.get(SETTINGS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.omniRouteVisionModel).toBe("gemini/gemini-2.5-flash");
    expect(persisted.omniRouteTranscriptionModel).toBeUndefined();

    const reloaded = await getSettings();
    expect(reloaded.omniRouteVisionModel).toBe("gemini/gemini-2.5-flash");
  });
});

describe("hasLocalLlmApiKey / setLocalLlmApiKey", () => {
  it("reports false when no key is stored, true after setting one, false after clearing", async () => {
    expect(await hasLocalLlmApiKey()).toBe(false);

    await setLocalLlmApiKey("local-secret-token");
    expect(await hasLocalLlmApiKey()).toBe(true);

    await setLocalLlmApiKey("");
    expect(await hasLocalLlmApiKey()).toBe(false);
  });
});

describe("localLlmUrl / localLlmModel default via getSettings", () => {
  it("defaults localLlmUrl and localLlmModel to empty strings on a fresh install", async () => {
    const s = await getSettings();
    expect(s.localLlmUrl).toBe("");
    expect(s.localLlmModel).toBe("");
    expect(s.localLlmApiKey).toBe("");
  });

  it("round-trips localLlmUrl/localLlmModel through saveSettings", async () => {
    const s = await getSettings();
    await saveSettings({ ...s, localLlmUrl: "http://127.0.0.1:8080", localLlmModel: "gemma-4" });
    const after = await getSettings();
    expect(after.localLlmUrl).toBe("http://127.0.0.1:8080");
    expect(after.localLlmModel).toBe("gemma-4");
  });
});
