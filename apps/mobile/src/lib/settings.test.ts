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
  getSettings,
  hasLocalLlmApiKey,
  saveSettings,
  setLocalLlmApiKey,
  type Settings,
} from "./settings";
import { resolveActiveProvider, type LlmProvider } from "./llmProviders";

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
    // (this blob predates llmProviders too, so it's migrated on read).
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://example.com",
    );
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

function findProvider(providers: readonly LlmProvider[], id: string): LlmProvider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error(`test fixture missing provider "${id}"`);
  return p;
}

// ── LLM provider list migration (Phase 2) ─────────────────────────────────────
// A pre-provider-list blob (a `llmBackend` field and/or flat
// omniRoute*/localLlm* fields, no `llmProviders` yet) is folded into the
// provider list on first read. Covers every llmBackend value (including the
// never-implemented "on-device"), a blob predating llmBackend entirely, the
// blank-local-URL loopback default, idempotency, round-tripping, and — the
// constraint most likely to break silently — that migration never touches
// SecureStore (the design spec's proposed key re-filing is deliberately NOT
// implemented; see providerKeys.ts).

describe("LLM provider list migration", () => {
  it("defaults to the omniroute preset (activeProviderId) with no persisted blob", async () => {
    const s = await getSettings();
    expect(s.activeProviderId).toBe("omniroute");
    expect(s.llmProviders.map((p) => p.id).sort()).toEqual(
      ["relais", "omniroute", "openai", "groq", "openrouter"].sort(),
    );
  });

  it.each([
    ["omniroute", "omniroute"],
    ["local", "relais"],
    ["on-device", "relais"],
  ] as const)(
    'migrates llmBackend "%s" to activeProviderId "%s"',
    async (legacyBackend, expectedActiveId) => {
      _async.set(
        SETTINGS_KEY,
        JSON.stringify({
          omniRouteUrl: "https://llm.example.com",
          omniRouteModel: "gpt-4o-mini",
          omniRouteVisionModel: "claude/claude-sonnet-4-6",
          llmBackend: legacyBackend,
          localLlmUrl: "http://192.168.1.5:8080",
          localLlmModel: "local-model",
          persistentNotificationEnabled: false,
          autoTranscribeOnSave: false,
          richEditorEnabled: true,
          previewBeforeSave: false,
          captureFolderPath: "",
          promptOverrides: {},
          karakeepUrl: "",
        }),
      );

      const s = await getSettings();
      expect(s.activeProviderId).toBe(expectedActiveId);
      const omniroute = findProvider(s.llmProviders, "omniroute");
      expect(omniroute.baseUrl).toBe("https://llm.example.com");
      expect(omniroute.model).toBe("gpt-4o-mini");
      expect(omniroute.visionModel).toBe("claude/claude-sonnet-4-6");
      const relais = findProvider(s.llmProviders, "relais");
      expect(relais.baseUrl).toBe("http://192.168.1.5:8080");
      expect(relais.model).toBe("local-model");
    },
  );

  it("defaults an old blob missing llmBackend entirely to activeProviderId omniroute (pre-B7 shape)", async () => {
    // Mirrors the real upgrade shape from before the llmBackend field
    // existed at all (post-B1/B4 keys present, llmBackend absent) —
    // DEFAULT_LLM_BACKEND was always "omniroute", so this must still be.
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
    expect(s.activeProviderId).toBe("omniroute");
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://llm.example.com",
    );
  });

  it("a blank legacy local URL keeps the relais preset's loopback default", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "",
        omniRouteModel: "",
        omniRouteVisionModel: "",
        llmBackend: "local",
        localLlmUrl: "",
        localLlmModel: "local-model",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    const relais = findProvider(s.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("local-model");
  });

  it("is idempotent — reading the same unmigrated blob twice yields structurally identical llmProviders/activeProviderId", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "local",
        localLlmUrl: "http://192.168.1.5:8080",
        localLlmModel: "local-model",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const first = await getSettings();
    const second = await getSettings();
    expect(second.activeProviderId).toBe(first.activeProviderId);
    expect(second.llmProviders).toEqual(first.llmProviders);
  });

  it("round-trips llmProviders + activeProviderId through save + load", async () => {
    const base = await getSettings();
    const next: Settings = {
      ...base,
      activeProviderId: "relais",
      llmProviders: base.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://192.168.1.9:8080", model: "gemma-4" }
          : p,
      ),
    };
    await saveSettings(next);

    const persisted = JSON.parse(_async.get(SETTINGS_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.activeProviderId).toBe("relais");

    const reloaded = await getSettings();
    expect(reloaded.activeProviderId).toBe("relais");
    expect(findProvider(reloaded.llmProviders, "relais").baseUrl).toBe(
      "http://192.168.1.9:8080",
    );
    expect(findProvider(reloaded.llmProviders, "relais").model).toBe(
      "gemma-4",
    );
  });

  it("never touches SecureStore — omniRoute/local-LLM keys stay at their original aliases, unmoved", async () => {
    _secure.set("carnet_omniroute_api_key", "omni-secret");
    _secure.set("carnet_local_llm_api_key", "local-secret");
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "omniroute",
        localLlmUrl: "",
        localLlmModel: "",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    // Readable at their ORIGINAL aliases, unmoved.
    expect(s.omniRouteApiKey).toBe("omni-secret");
    expect(s.localLlmApiKey).toBe("local-secret");
    expect(_secure.get("carnet_omniroute_api_key")).toBe("omni-secret");
    expect(_secure.get("carnet_local_llm_api_key")).toBe("local-secret");
    // No re-filed alias was ever written (the spec's proposed
    // carnet.llm.key.<id> re-filing step is deliberately not implemented).
    expect(_secure.has("carnet.llm.key.omniroute")).toBe(false);
    expect(_secure.has("carnet.llm.key.relais")).toBe(false);
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

describe("relais provider default via getSettings", () => {
  it("defaults the relais entry to the loopback URL and an empty model on a fresh install", async () => {
    const s = await getSettings();
    const relais = resolveActiveProvider(s.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("");
    expect(s.localLlmApiKey).toBe("");
  });

  it("round-trips an edited relais entry through saveSettings", async () => {
    const s = await getSettings();
    await saveSettings({
      ...s,
      llmProviders: s.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "gemma-4" }
          : p,
      ),
    });
    const after = await getSettings();
    const relais = resolveActiveProvider(after.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("gemma-4");
  });
});
