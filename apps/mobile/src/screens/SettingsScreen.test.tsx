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
//
// The LLM provider UI (Phase 4 — see
// docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI") is
// components/LlmProviderSection.tsx, rendered here for real (not stubbed) —
// it owns its own persistence (savePersistedOnly) and its own SecureStore
// key IO (lib/providerKeys.ts, real, backed by an in-memory
// expo-secure-store mock below — same pattern as providerKeys.test.ts), so
// these tests exercise the actual switch/add/delete/health-check flows
// end-to-end, not a stub.
//
// Native-module-heavy children (DiagnosticsSection, VoiceSetupCheck) are
// stubbed out — they have their own dedicated tests and pull in
// AsyncStorage/expo-clipboard/on-device STT probes that are irrelevant here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { Settings } from "../lib/settings";
import { buildDefaultProviders, type LlmProvider } from "../lib/llmProviders";

const customProvider: LlmProvider = {
  id: "custom-1",
  label: "My Server",
  baseUrl: "https://my.server",
  model: "",
  visionModel: "",
  preset: null,
};

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProviders: buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, baseUrl: "https://llm.grepon.cc" } : p,
    ),
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    omniRouteApiKey: "",
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

// In-memory SecureStore mock — same pattern as providerKeys.test.ts. LLM
// provider keys (lib/providerKeys.ts) are REAL in this test file, not
// stubbed, so the key-deletion mandatory case has real evidence to assert
// against — a mocked providerKeys module could pass that test for the wrong
// reason (see the "mutate the source, confirm red" instruction).
const _secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => _secure.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    _secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    _secure.delete(k);
  }),
}));

const getSettings = vi.fn(async () => baseSettings());
const saveSettings = vi.fn(async (_s: Settings) => undefined);
const savePersistedOnly = vi.fn(async (_s: Settings) => undefined);
const hasKarakeepApiKey = vi.fn(async () => false);
const shouldShowMigrationBanner = vi.fn(async () => false);
const dismissMigrationBanner = vi.fn(async () => undefined);
const setKarakeepApiKey = vi.fn(async (_key: string) => undefined);

vi.mock("../lib/settings", () => ({
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
  DEFAULT_VISION_MODEL: "openrouter/openai/gpt-4o-mini",
  getSettings: () => getSettings(),
  saveSettings: (s: Settings) => saveSettings(s),
  savePersistedOnly: (s: Settings) => savePersistedOnly(s),
  hasKarakeepApiKey: () => hasKarakeepApiKey(),
  shouldShowMigrationBanner: () => shouldShowMigrationBanner(),
  dismissMigrationBanner: () => dismissMigrationBanner(),
  setKarakeepApiKey: (key: string) => setKarakeepApiKey(key),
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
  _secure.clear();
  getSettings.mockResolvedValue(baseSettings());
  saveSettings.mockResolvedValue(undefined);
  savePersistedOnly.mockResolvedValue(undefined);
  hasKarakeepApiKey.mockResolvedValue(false);
  shouldShowMigrationBanner.mockResolvedValue(false);
  listModels.mockResolvedValue(["pick-me-model", "other-model"]);
  healthCheck.mockResolvedValue("ok");
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

  describe("LLM provider section", () => {
    it("switching the active provider persists it", async () => {
      renderScreen();

      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));

      await waitFor(() => {
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ activeProviderId: "relais" }),
        );
      });
      // The section re-renders around the newly active entry.
      expect(await screen.findByPlaceholderText("http://127.0.0.1:8080")).toBeTruthy();
    });

    it("adding a custom entry, then deleting it, deletes its stored key", async () => {
      // Mutation-catch target: swapping providerKeys.removeProviderAndKey
      // for llmProviders.removeProvider in LlmProviderSection.tsx must turn
      // this test red — removeProvider never touches SecureStore, so the
      // key would still be sitting under "carnet.llm.key.custom-1" at the
      // final assertion.
      renderScreen();

      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(await screen.findByPlaceholderText("e.g. My Ollama"), {
        target: { value: "My Server" },
      });
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      fireEvent.click(screen.getByText("Add"));

      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ nextCustomSeq: 2 }),
        ),
      );

      // Make the new entry active so its fields (and key field) render.
      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("My Server"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ activeProviderId: "custom-1" }),
        ),
      );

      // Type and save an API key for it.
      fireEvent.change(screen.getByPlaceholderText("sk-..."), {
        target: { value: "sk-custom-secret" },
      });
      fireEvent.click(screen.getByText("Save provider"));
      await waitFor(() => expect(_secure.get("carnet.llm.key.custom-1")).toBe("sk-custom-secret"));

      // Delete it via the active-entry delete affordance (visible because
      // it's a custom entry) and confirm.
      fireEvent.click(await screen.findByText("Delete this provider"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(_secure.has("carnet.llm.key.custom-1")).toBe(false));
    });

    it("a preset offers no delete affordance", async () => {
      renderScreen();

      // Seed a custom entry so the picker has both kinds of rows to compare.
      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(await screen.findByPlaceholderText("e.g. My Ollama"), {
        target: { value: "My Server" },
      });
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      fireEvent.click(screen.getByText("Add"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ nextCustomSeq: 2 }),
        ),
      );

      fireEvent.click(await screen.findByText("Active provider — tap to change"));

      expect(await screen.findByLabelText("Delete My Server")).toBeTruthy();
      expect(screen.queryByLabelText("Delete OmniRoute")).toBeNull();
      expect(screen.queryByLabelText("Delete Relais (local)")).toBeNull();
    });

    it("deleting the active provider does not leave activeProviderId dangling", async () => {
      getSettings.mockResolvedValue(
        baseSettings({
          llmProviders: [...buildDefaultProviders(), customProvider],
          activeProviderId: "custom-1",
        }),
      );

      renderScreen();

      expect(await screen.findByText("Delete this provider")).toBeTruthy();
      fireEvent.click(screen.getByText("Delete this provider"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({
            activeProviderId: "omniroute",
            fallbackProviderId: null,
            visionProviderId: null,
          }),
        ),
      );
      // The section re-renders around the reassigned active entry, not a
      // dangling reference to the just-deleted one.
      expect(await screen.findByText("OmniRoute")).toBeTruthy();
    });

    describe("Test connection result", () => {
      it.each([
        ["unreachable", /check the URL and that the server is running/i],
        ["blocked-cleartext", /Android blocked this plain http/i],
        ["unsafe-url", /Not a valid local address/i],
        ["ok", /Reachable/],
      ] as const)("renders the %s message", async (result, pattern) => {
        healthCheck.mockResolvedValueOnce(result as never);

        renderScreen();

        fireEvent.click(await screen.findByText("Test connection"));
        expect(await screen.findByText(pattern)).toBeTruthy();
      });
    });
  });
});
