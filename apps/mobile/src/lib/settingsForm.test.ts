import { describe, expect, it, vi } from "vitest";

// ./settings pulls in the native AsyncStorage/SecureStore bindings (via
// expo-modules-core) at import time — mock them so this pure-helper test can
// load the module under Node + vitest. Same pattern as settings.test.ts.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  DEFAULT_LLM_BACKEND,
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
} from "./settings";
import {
  captureFolderLabel,
  composeSettingsForSave,
  type FormState,
} from "./settingsForm";

const baseForm: FormState = {
  omniRouteUrl: "https://llm.grepon.cc",
  omniRouteModel: "gemini/gemini-2.5-flash",
  omniRouteVisionModel: "openai/gpt-4o-mini",
  persistentNotificationEnabled: true,
  autoTranscribeOnSave: false,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "content://tree/primary%3AObsidian",
  promptOverrides: { idea: "custom idea prompt" },
  karakeepUrl: "https://karakeep.example.com",
};

const keys = { omniRouteApiKey: "sk-existing", karakeepApiKey: "kk-existing" };

describe("composeSettingsForSave", () => {
  it("threads form fields through verbatim and carries the existing keys", () => {
    const next = composeSettingsForSave(baseForm, keys);
    expect(next).toEqual({
      omniRouteUrl: "https://llm.grepon.cc",
      omniRouteModel: "gemini/gemini-2.5-flash",
      omniRouteVisionModel: "openai/gpt-4o-mini",
      llmBackend: DEFAULT_LLM_BACKEND,
      persistentNotificationEnabled: true,
      autoTranscribeOnSave: false,
      richEditorEnabled: true,
      previewBeforeSave: false,
      omniRouteApiKey: "sk-existing",
      captureFolderPath: "content://tree/primary%3AObsidian",
      promptOverrides: { idea: "custom idea prompt" },
      karakeepUrl: "https://karakeep.example.com",
      karakeepApiKey: "kk-existing",
    });
  });

  it("falls back to the default chat model when the field is blank", () => {
    const next = composeSettingsForSave(
      { ...baseForm, omniRouteModel: "" },
      keys,
    );
    expect(next.omniRouteModel).toBe(DEFAULT_OMNIROUTE_MODEL);
  });

  it("falls back to the default vision model when the field is blank", () => {
    const next = composeSettingsForSave(
      { ...baseForm, omniRouteVisionModel: "" },
      keys,
    );
    expect(next.omniRouteVisionModel).toBe(DEFAULT_VISION_MODEL);
  });

  it("always persists the default backend (no picker UI in Phase 1)", () => {
    const next = composeSettingsForSave(baseForm, keys);
    expect(next.llmBackend).toBe(DEFAULT_LLM_BACKEND);
  });

  it("passes empty existing keys straight through (so saveSettings clears them)", () => {
    const next = composeSettingsForSave(baseForm, {
      omniRouteApiKey: "",
      karakeepApiKey: "",
    });
    expect(next.omniRouteApiKey).toBe("");
    expect(next.karakeepApiKey).toBe("");
  });

  it("does not mutate the input form", () => {
    const form = { ...baseForm, omniRouteModel: "" };
    composeSettingsForSave(form, keys);
    expect(form.omniRouteModel).toBe("");
  });
});

describe("captureFolderLabel", () => {
  it("returns an empty string for a blank path", () => {
    expect(captureFolderLabel("")).toBe("");
  });

  it("returns a plain filesystem path unchanged", () => {
    expect(captureFolderLabel("/storage/emulated/0/carnet")).toBe(
      "/storage/emulated/0/carnet",
    );
  });

  it("decodes and trims a SAF tree URI to its readable tail", () => {
    expect(
      captureFolderLabel(
        "content://com.android.externalstorage.documents/tree/primary%3AObsidian%2FCarnet",
      ),
    ).toBe("primary:Obsidian/Carnet");
  });

  it("returns the decoded whole string when there is no tree/ segment", () => {
    expect(captureFolderLabel("content://provider/document%2Ffoo")).toBe(
      "content://provider/document/foo",
    );
  });
});
