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

import { DEFAULT_OMNIROUTE_MODEL, DEFAULT_VISION_MODEL } from "./settings";
import {
  apiKeyFieldLabel,
  apiKeyFieldPlaceholder,
  captureFolderLabel,
  composeSettingsForSave,
  errorMessage,
  existingApiKeysFromSettings,
  formStateFromSettings,
  type FormState,
} from "./settingsForm";
import type { Settings } from "./settings";
import { buildDefaultProviders, type LlmProvider } from "./llmProviders";

function findProvider(providers: readonly LlmProvider[], id: string): LlmProvider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error(`test fixture missing provider "${id}"`);
  return p;
}

const baseForm: FormState = {
  omniRouteUrl: "https://llm.grepon.cc",
  omniRouteModel: "gemini/gemini-2.5-flash",
  omniRouteVisionModel: "openai/gpt-4o-mini",
  llmBackend: "omniroute",
  localLlmUrl: "",
  localLlmModel: "",
  persistentNotificationEnabled: true,
  autoTranscribeOnSave: false,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "content://tree/primary%3AObsidian",
  promptOverrides: { idea: "custom idea prompt" },
  karakeepUrl: "https://karakeep.example.com",
};

const keys = {
  omniRouteApiKey: "sk-existing",
  karakeepApiKey: "kk-existing",
  localLlmApiKey: "",
};

describe("composeSettingsForSave", () => {
  it("threads form fields through verbatim and carries the existing keys", () => {
    const next = composeSettingsForSave(baseForm, keys, buildDefaultProviders());
    expect(next.activeProviderId).toBe("omniroute");
    expect(next.omniRouteApiKey).toBe("sk-existing");
    expect(next.karakeepApiKey).toBe("kk-existing");
    expect(next.localLlmApiKey).toBe("");
    expect(next.persistentNotificationEnabled).toBe(true);
    expect(next.autoTranscribeOnSave).toBe(false);
    expect(next.richEditorEnabled).toBe(true);
    expect(next.previewBeforeSave).toBe(false);
    expect(next.captureFolderPath).toBe("content://tree/primary%3AObsidian");
    expect(next.promptOverrides).toEqual({ idea: "custom idea prompt" });
    expect(next.karakeepUrl).toBe("https://karakeep.example.com");

    const omniroute = findProvider(next.llmProviders, "omniroute");
    expect(omniroute.baseUrl).toBe("https://llm.grepon.cc");
    expect(omniroute.model).toBe("gemini/gemini-2.5-flash");
    expect(omniroute.visionModel).toBe("openai/gpt-4o-mini");
  });

  it("falls back to the default chat model when the field is blank", () => {
    const next = composeSettingsForSave(
      { ...baseForm, omniRouteModel: "" },
      keys,
      buildDefaultProviders(),
    );
    expect(findProvider(next.llmProviders, "omniroute").model).toBe(
      DEFAULT_OMNIROUTE_MODEL,
    );
  });

  it("falls back to the default vision model when the field is blank", () => {
    const next = composeSettingsForSave(
      { ...baseForm, omniRouteVisionModel: "" },
      keys,
      buildDefaultProviders(),
    );
    expect(findProvider(next.llmProviders, "omniroute").visionModel).toBe(
      DEFAULT_VISION_MODEL,
    );
  });

  it("passes empty existing keys straight through (so saveSettings clears them)", () => {
    const next = composeSettingsForSave(
      baseForm,
      { omniRouteApiKey: "", karakeepApiKey: "", localLlmApiKey: "" },
      buildDefaultProviders(),
    );
    expect(next.omniRouteApiKey).toBe("");
    expect(next.karakeepApiKey).toBe("");
  });

  it("threads the existing localLlmApiKey through unchanged (no picker UI yet)", () => {
    const next = composeSettingsForSave(
      baseForm,
      { ...keys, localLlmApiKey: "local-secret" },
      buildDefaultProviders(),
    );
    expect(next.localLlmApiKey).toBe("local-secret");
  });

  it("passes the user's selected llmBackend through instead of forcing the default", () => {
    const form: FormState = {
      ...baseForm,
      llmBackend: "local",
      localLlmUrl: "http://127.0.0.1:8080",
      localLlmModel: "gemma-4",
    };
    const result = composeSettingsForSave(
      form,
      { omniRouteApiKey: "", karakeepApiKey: "", localLlmApiKey: "local-key" },
      buildDefaultProviders(),
    );

    expect(result.activeProviderId).toBe("relais");
    const relais = findProvider(result.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("gemma-4");
    expect(result.localLlmApiKey).toBe("local-key");
  });

  it("preserves provider entries the current form has no UI for (e.g. openai, custom)", () => {
    const providers = [
      ...buildDefaultProviders(),
      {
        id: "custom-1",
        label: "My Server",
        baseUrl: "https://my.server",
        model: "some-model",
        visionModel: "",
        preset: null,
      },
    ];
    const next = composeSettingsForSave(baseForm, keys, providers);
    expect(findProvider(next.llmProviders, "openai")).toBeTruthy();
    expect(findProvider(next.llmProviders, "custom-1")).toEqual({
      id: "custom-1",
      label: "My Server",
      baseUrl: "https://my.server",
      model: "some-model",
      visionModel: "",
      preset: null,
    });
  });

  it("does not mutate the input form or the input provider list", () => {
    const form = { ...baseForm, omniRouteModel: "" };
    const providers = buildDefaultProviders();
    const providersSnapshot = providers.map((p) => ({ ...p }));
    composeSettingsForSave(form, keys, providers);
    expect(form.omniRouteModel).toBe("");
    expect(providers).toEqual(providersSnapshot);
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

describe("errorMessage", () => {
  it("uses the Error's message when e is an Error instance", () => {
    expect(errorMessage(new Error("boom"), "Save failed")).toBe(
      "Save failed: boom",
    );
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string", "Save failed")).toBe(
      "Save failed: plain string",
    );
  });

  it("truncates the underlying message to 120 chars", () => {
    const long = "x".repeat(200);
    const result = errorMessage(new Error(long), "Save failed");
    // "Save failed: " (13 chars) + 120 chars of message
    expect(result).toBe(`Save failed: ${"x".repeat(120)}`);
  });
});

describe("existingApiKeysFromSettings", () => {
  const base: Settings = {
    llmProviders: buildDefaultProviders(),
    activeProviderId: "omniroute",
    omniRouteApiKey: "sk-existing",
    localLlmApiKey: "local-secret",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: true,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "kk-existing",
  };

  it("reads each key straight through when present", () => {
    expect(existingApiKeysFromSettings(base)).toEqual({
      omniRouteApiKey: "sk-existing",
      karakeepApiKey: "kk-existing",
      localLlmApiKey: "local-secret",
    });
  });

  it("defaults missing/undefined keys to empty string, not undefined", () => {
    // Mutation-catch: if the implementation returned `s.omniRouteApiKey`
    // verbatim (no `?? ""`), this would assert undefined !== "" and fail —
    // a caller (saveSettings) that treats undefined as "no key" differently
    // from "" would then wipe/keep the key incorrectly.
    const sparse = {
      ...base,
      omniRouteApiKey: undefined as unknown as string,
      karakeepApiKey: undefined as unknown as string,
      localLlmApiKey: undefined as unknown as string,
    };
    expect(existingApiKeysFromSettings(sparse)).toEqual({
      omniRouteApiKey: "",
      karakeepApiKey: "",
      localLlmApiKey: "",
    });
  });
});

describe("apiKeyFieldLabel", () => {
  it("appends (configured) when a key is stored and nothing new is typed", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", true, 0)).toBe(
      "OmniRoute API key (configured)",
    );
  });

  it("drops the suffix once the user starts typing a replacement", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", true, 3)).toBe(
      "OmniRoute API key",
    );
  });

  it("drops the suffix when no key is configured", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", false, 0)).toBe(
      "OmniRoute API key",
    );
  });
});

describe("apiKeyFieldPlaceholder", () => {
  it("shows the configured hint when a key is stored", () => {
    expect(apiKeyFieldPlaceholder(true, "sk-...")).toBe(
      "•••• configured — tap to replace",
    );
  });

  it("falls back to the caller-supplied blank-state hint otherwise", () => {
    expect(apiKeyFieldPlaceholder(false, "sk-...")).toBe("sk-...");
  });
});

describe("formStateFromSettings", () => {
  const settings: Settings = {
    llmProviders: buildDefaultProviders().map((p) => {
      if (p.id === "omniroute") {
        return {
          ...p,
          baseUrl: "https://llm.grepon.cc",
          model: "gemini/gemini-2.5-flash",
          visionModel: "openai/gpt-4o-mini",
        };
      }
      if (p.id === "relais") {
        return { ...p, baseUrl: "http://127.0.0.1:8080", model: "gemma-4" };
      }
      return p;
    }),
    activeProviderId: "relais",
    omniRouteApiKey: "sk-existing",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: true,
    richEditorEnabled: true,
    previewBeforeSave: true,
    captureFolderPath: "/storage/emulated/0/carnet",
    promptOverrides: { idea: "custom" },
    karakeepUrl: "https://karakeep.example.com",
    karakeepApiKey: "",
  };

  it("maps every non-secret Settings field onto FormState", () => {
    expect(formStateFromSettings(settings, false)).toEqual({
      omniRouteUrl: "https://llm.grepon.cc",
      omniRouteModel: "gemini/gemini-2.5-flash",
      omniRouteVisionModel: "openai/gpt-4o-mini",
      llmBackend: "local",
      localLlmUrl: "http://127.0.0.1:8080",
      localLlmModel: "gemma-4",
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: true,
      richEditorEnabled: true,
      previewBeforeSave: true,
      captureFolderPath: "/storage/emulated/0/carnet",
      promptOverrides: { idea: "custom" },
      karakeepUrl: "https://karakeep.example.com",
    });
  });

  it("uses the passed-in notification value, NOT settings.persistentNotificationEnabled", () => {
    // Mutation-catch: if the implementation read
    // `s.persistentNotificationEnabled` instead of the second parameter,
    // this would assert false (settings' own value) and fail — the whole
    // point of the separate parameter is that the caller reconciles this
    // value against native state before the form is built.
    const result = formStateFromSettings(settings, true);
    expect(result.persistentNotificationEnabled).toBe(true);
  });

  it("maps activeProviderId 'omniroute' to llmBackend 'omniroute'", () => {
    const result = formStateFromSettings(
      { ...settings, activeProviderId: "omniroute" },
      false,
    );
    expect(result.llmBackend).toBe("omniroute");
  });
});
