// @vitest-environment jsdom
//
// Screen smoke test (pattern: see TagBrowserScreen.test.tsx). Covers
// behaviors that are easy to silently break during refactors of this screen:
//
//   (a) the mount-time notification reconcile happy path — native ON +
//       permission revoked must force-stop the service AND render the
//       toggle OFF.
//   (a2) the SAME scenario but with a rejecting stop() — this is the one
//       that actually catches a regression of the stop()-before-assign
//       ordering fix (see lib/settingsPersistence.ts
//       reconcileInitialNotificationState and the comment at its call
//       site); (a) alone can't, because both orderings converge when
//       stop() resolves.
//   (b) LocalLlmSection prop threading — llmBackend === "local" must render
//       its URL/key/model fields and Test-connection button via the real
//       extracted component, not a stub.
//   (c) ModelBrowserModal + applyPickedModel wiring — picking a model while
//       browseTarget === "vision" must update ONLY the vision field.
//
// Native-module-heavy children (DiagnosticsSection, VoiceSetupCheck) are
// stubbed out — they have their own dedicated tests and pull in
// AsyncStorage/expo-clipboard/on-device STT probes that are irrelevant here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { Settings } from "../lib/settings";

// Both DEFAULT_OMNIROUTE_MODEL and DEFAULT_VISION_MODEL are this same
// literal in the real lib/settings.ts — used as the placeholder for both
// the chat-model and vision-model TextInputs, so getAllByPlaceholderText
// against it returns [chatInput, visionInput] in that JSX order.
const MODEL_PLACEHOLDER = "openrouter/openai/gpt-4o-mini";

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    omniRouteUrl: "https://llm.grepon.cc",
    omniRouteApiKey: "",
    omniRouteModel: "",
    omniRouteVisionModel: "",
    llmBackend: "omniroute",
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: true,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
    ...overrides,
  };
}

const getSettings = vi.fn(async () => baseSettings());
const saveSettings = vi.fn(async (_s: Settings) => undefined);
const hasOmniRouteApiKey = vi.fn(async () => false);
const hasKarakeepApiKey = vi.fn(async () => false);
const hasLocalLlmApiKey = vi.fn(async () => false);
const shouldShowMigrationBanner = vi.fn(async () => false);
const dismissMigrationBanner = vi.fn(async () => undefined);
const setOmniRouteApiKey = vi.fn(async (_key: string) => undefined);
const setKarakeepApiKey = vi.fn(async (_key: string) => undefined);
const setLocalLlmApiKey = vi.fn(async (_key: string) => undefined);

vi.mock("../lib/settings", () => ({
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
  DEFAULT_VISION_MODEL: "openrouter/openai/gpt-4o-mini",
  getSettings: () => getSettings(),
  saveSettings: (s: Settings) => saveSettings(s),
  hasOmniRouteApiKey: () => hasOmniRouteApiKey(),
  hasKarakeepApiKey: () => hasKarakeepApiKey(),
  hasLocalLlmApiKey: () => hasLocalLlmApiKey(),
  shouldShowMigrationBanner: () => shouldShowMigrationBanner(),
  dismissMigrationBanner: () => dismissMigrationBanner(),
  setOmniRouteApiKey: (key: string) => setOmniRouteApiKey(key),
  setKarakeepApiKey: (key: string) => setKarakeepApiKey(key),
  setLocalLlmApiKey: (key: string) => setLocalLlmApiKey(key),
}));

const listModels = vi.fn(async (_url: string, _key: string) => [
  "pick-me-model",
  "other-model",
]);
vi.mock("../lib/dispatcher", () => ({
  listModels: (url: string, key: string) => listModels(url, key),
}));

const healthCheck = vi.fn(async (_url: string) => "ok" as const);
vi.mock("../lib/llmClient", () => ({
  healthCheck: (url: string) => healthCheck(url),
}));

const isAvailable = vi.fn(() => true);
const requestPermission = vi.fn(async () => true);
const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const isEnabled = vi.fn(async () => false);
const permissionIsGranted = vi.fn(async () => true);
vi.mock("../lib/captureNotification", () => ({
  isAvailable: () => isAvailable(),
  requestPermission: () => requestPermission(),
  start: () => start(),
  stop: () => stop(),
  isEnabled: () => isEnabled(),
  permissionIsGranted: () => permissionIsGranted(),
}));

vi.mock("../components/DiagnosticsSection", () => ({
  DiagnosticsSection: () => null,
}));

vi.mock("../voice/VoiceSetupCheck", () => ({
  VoiceSetupCheck: () => null,
}));

import SettingsScreen from "./SettingsScreen";

function renderScreen() {
  return render(
    <PaperProvider theme={carnetLight}>
      <SettingsScreen />
    </PaperProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(baseSettings());
  saveSettings.mockResolvedValue(undefined);
  hasOmniRouteApiKey.mockResolvedValue(false);
  hasKarakeepApiKey.mockResolvedValue(false);
  hasLocalLlmApiKey.mockResolvedValue(false);
  shouldShowMigrationBanner.mockResolvedValue(false);
  listModels.mockResolvedValue(["pick-me-model", "other-model"]);
  isAvailable.mockReturnValue(true);
  requestPermission.mockResolvedValue(true);
  start.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  isEnabled.mockResolvedValue(false);
  permissionIsGranted.mockResolvedValue(true);
});

// RTL's automatic cleanup needs vitest globals (this repo runs without
// them), so unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe("SettingsScreen", () => {
  it("force-stops and renders the notification toggle OFF when native is ON but permission was revoked", async () => {
    isEnabled.mockResolvedValue(true);
    permissionIsGranted.mockResolvedValue(false);

    renderScreen();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    // Switches render in JSX order: AI-behavior's two switches
    // (autoTranscribeOnSave, previewBeforeSave), then Capture surfaces'
    // persistent-notification switch — index 2 is the one under test.
    const switches = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(switches).toHaveLength(3);
    expect(switches[2].checked).toBe(false);
  });

  it("keeps the JS-side hint (does NOT adopt reconciled OFF) when the force-stop itself rejects", async () => {
    // Regression guard for the mount-reconcile ordering fix. When stop()
    // resolves, both orderings (assign-then-stop vs stop-then-assign)
    // produce the same final state, so the test above alone can't catch a
    // reordering regression. This one can: with stop() before assign (the
    // fix), a rejecting stop() throws before `initialNotificationEnabled`
    // is ever reassigned, so the outer catch preserves the JS-side hint
    // (true here). Swap the two lines back (assign-then-stop, the bug) and
    // the assignment to `false` already landed before stop() rejects, so
    // this assertion flips and the test fails.
    isEnabled.mockResolvedValue(true);
    permissionIsGranted.mockResolvedValue(false);
    stop.mockRejectedValue(new Error("service already dead"));
    getSettings.mockResolvedValue(
      baseSettings({ persistentNotificationEnabled: true }),
    );

    renderScreen();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    const switches = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(switches[2].checked).toBe(true);
  });

  it("renders the Local-LLM section (URL, key, model, Test connection) when llmBackend is local", async () => {
    getSettings.mockResolvedValue(baseSettings({ llmBackend: "local" }));

    renderScreen();

    expect(await screen.findByText("Local LLM")).toBeTruthy();
    expect(screen.getByPlaceholderText("http://127.0.0.1:8080")).toBeTruthy();
    expect(
      screen.getByPlaceholderText(
        "e.g. litert-community/gemma-4-E4B-it-litert-lm",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Test connection")).toBeTruthy();
    // Local-LLM key field is optional and unconfigured by default.
    expect(
      screen.getByPlaceholderText(
        "optional — leave blank for an unauthenticated loopback server",
      ),
    ).toBeTruthy();
  });

  it("picking a model for the vision target updates only the vision field, not the chat model", async () => {
    renderScreen();

    const browseButtons = await screen.findAllByText("Browse available models");
    expect(browseButtons).toHaveLength(2); // [chat, vision]
    fireEvent.click(browseButtons[1]);

    const pick = await screen.findByText("pick-me-model");
    fireEvent.click(pick);

    await waitFor(() => {
      const [chatInput, visionInput] = screen.getAllByPlaceholderText(
        MODEL_PLACEHOLDER,
      ) as HTMLInputElement[];
      expect(visionInput.value).toBe("pick-me-model");
      expect(chatInput.value).toBe("");
    });
  });

  // (d) Test-connection result threading. healthCheck used to return a boolean
  // folded through `ok ? "ok" : "unreachable"`. When it became a discriminated
  // string, that ternary made EVERY outcome truthy — a blocked or unreachable
  // server would have rendered "✓ Reachable". typecheck cannot catch that,
  // because a string is a valid ternary condition. This asserts the failure
  // states actually reach the UI.
  describe("Test connection result", () => {
    it.each([
      ["unreachable", /check the URL and that the server is running/i],
      ["blocked-cleartext", /Android blocked this plain http/i],
      ["unsafe-url", /Not a valid local address/i],
      ["ok", /Reachable/],
    ] as const)("renders the %s message", async (result, pattern) => {
      getSettings.mockResolvedValue(baseSettings({ llmBackend: "local" }));
      healthCheck.mockResolvedValueOnce(result as never);

      renderScreen();

      fireEvent.click(await screen.findByText("Test connection"));
      expect(await screen.findByText(pattern)).toBeTruthy();
    });
  });
});
