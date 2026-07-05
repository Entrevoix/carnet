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
  saveSettings,
  type Settings,
} from "./settings";

const SETTINGS_KEY = "carnet:settings:v2";

beforeEach(() => {
  _async.clear();
  _secure.clear();
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
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: false,
      richEditorEnabled: true,
      captureFolderPath: "",
      promptOverrides: {},
      karakeepUrl: "",
      karakeepApiKey: "",
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
