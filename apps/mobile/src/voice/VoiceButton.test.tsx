// @vitest-environment jsdom
//
// Component smoke oracle for VoiceButton, built BEFORE its planned
// decomposition so these assertions pin user-visible behavior (rendered
// state, accessibility label, callback invocations) that must survive the
// refactor unchanged. Renders the REAL component tree (react-native aliased
// to react-native-web, real react-native-paper) under PaperProvider, per the
// TagBrowserScreen.test.tsx pattern. expo-speech-recognition has no vitest
// stub (unlike expo-haptics/expo-sqlite/etc in vitest.config.ts), so it's
// fully vi.mock'd here with a tiny event-bus so tests can fire native
// lifecycle events (`result`, `error`, `end`) exactly like the OS would.
//
// This file deliberately does NOT re-test the pure collaborator modules
// (dictationSession.ts, recognizerSelect.ts, sttErrorMessage.ts,
// sttErrorPolicy.ts, sttOnboarding.ts, sttReadiness.ts) — each has its own
// *.test.ts covering the branch logic exhaustively. Here we only pin how
// VoiceButton WIRES those decisions to native calls, AsyncStorage, and the
// rendered error sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";
import { createRef } from "react";

import { carnetLight } from "../lib/theme";

// ── AsyncStorage: shared in-memory store, same pattern as
// src/lib/crashReporting.test.ts / src/lib/journalTagIndex.test.ts. ─────────
const _store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

// expo-clipboard: only exercised by "Copy diagnostics" — stub the one method
// VoiceButton calls (Clipboard.setStringAsync).
vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => {}),
}));

// requireOptionalNativeModule (openAppDetails' ExpoIntentLauncher lookup) —
// null mirrors a client built before the native module shipped, which is the
// production fallback path VoiceButton is written to handle.
vi.mock("expo", () => ({
  requireOptionalNativeModule: vi.fn(() => null),
}));

// expo-speech-recognition: no vitest.config.ts alias exists for it (unlike
// expo-haptics/expo-sqlite/etc), so it's fully replaced here. `__emit` is a
// test-only escape hatch letting tests fire the exact native events
// (`result`, `error`, `end`, `start`, `audiostart`, ...) VoiceButton
// subscribes to via addListener.
vi.mock("expo-speech-recognition", () => {
  const listeners: Record<string, Array<(event?: unknown) => void>> = {};
  const addListener = (event: string, cb: (event?: unknown) => void) => {
    (listeners[event] ??= []).push(cb);
    return {
      remove: () => {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
      },
    };
  };
  const emit = (event: string, payload?: unknown) => {
    (listeners[event] ?? []).slice().forEach((cb) => cb(payload));
  };
  return {
    ExpoSpeechRecognitionModule: {
      addListener,
      __emit: emit,
      start: vi.fn(),
      stop: vi.fn(),
      getPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
      requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
      getSupportedLocales: vi.fn(async () => ({
        locales: ["en-US"],
        installedLocales: ["en-US"],
      })),
      getSpeechRecognitionServices: vi.fn(() => [
        "com.google.android.tts",
        "com.google.android.as",
      ]),
      getDefaultRecognitionService: vi.fn(() => ({ packageName: "com.google.android.tts" })),
    },
  };
});

import {
  VoiceButton,
  STT_RECOGNIZER_PKG_KEY,
  STT_RECOGNIZER_LABEL_KEY,
  type VoiceButtonHandle,
} from "./VoiceButton";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockModule = ExpoSpeechRecognitionModule as any;

function renderVoiceButton(opts?: { disabled?: boolean }) {
  const onTranscript = vi.fn();
  const ref = createRef<VoiceButtonHandle>();
  render(
    <PaperProvider theme={carnetLight}>
      <VoiceButton onTranscript={onTranscript} disabled={opts?.disabled} ref={ref} />
    </PaperProvider>,
  );
  return { onTranscript, ref };
}

function tap(el: HTMLElement) {
  fireEvent.click(el);
}

async function tapStart() {
  const btn = screen.getByLabelText("Start dictation");
  tap(btn);
  // startOnDevice awaits getPermissionsAsync + AsyncStorage.getItem + the
  // native start() call before isListening flips — flush those microtasks.
  await waitFor(() => screen.getByLabelText("Stop dictation"));
}

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
  // Re-seed default implementations clearAllMocks doesn't touch (it clears
  // call history, not queued resolved values set via mockResolvedValueOnce
  // from a PRIOR test — but a plain vi.fn() with no queued once-impl always
  // falls through here) — explicit for readability/robustness.
  mockModule.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  mockModule.requestPermissionsAsync.mockResolvedValue({ granted: true });
  mockModule.getSupportedLocales.mockResolvedValue({
    locales: ["en-US"],
    installedLocales: ["en-US"],
  });
  mockModule.getSpeechRecognitionServices.mockReturnValue([
    "com.google.android.tts",
    "com.google.android.as",
  ]);
  mockModule.getDefaultRecognitionService.mockReturnValue({
    packageName: "com.google.android.tts",
  });
});

afterEach(cleanup);

describe("VoiceButton", () => {
  it("renders idle with the mic icon and 'Start dictation' label", () => {
    renderVoiceButton();
    expect(screen.getByLabelText("Start dictation")).toBeTruthy();
    expect(screen.queryByLabelText("Stop dictation")).toBeNull();
  });

  it("tap starts recognition: requests mic permission and starts the pinned default recognizer", async () => {
    renderVoiceButton();
    await tapStart();

    expect(mockModule.getPermissionsAsync).toHaveBeenCalled();
    expect(mockModule.start).toHaveBeenCalledTimes(1);
    const startArgs = mockModule.start.mock.calls[0][0];
    // No persisted pkg → resolveEffectivePkg pins the first default recognizer
    // (com.google.android.tts, per recognizerSelect.ts DEFAULT_RECOGNIZER_PKGS).
    expect(startArgs.androidRecognitionServicePackage).toBe("com.google.android.tts");
    expect(startArgs.continuous).toBe(true);
  });

  it("honors a persisted recognizer package/label from AsyncStorage on tap", async () => {
    _store.set(STT_RECOGNIZER_PKG_KEY, "com.google.android.as");
    _store.set(STT_RECOGNIZER_LABEL_KEY, "Google (On-Device)");
    renderVoiceButton();
    await tapStart();

    expect(mockModule.start).toHaveBeenCalledTimes(1);
    const startArgs = mockModule.start.mock.calls[0][0];
    expect(startArgs.androidRecognitionServicePackage).toBe("com.google.android.as");
  });

  it("a `result` event flows the transcript to onTranscript as a non-final update", async () => {
    const { onTranscript } = renderVoiceButton();
    await tapStart();
    onTranscript.mockClear();

    mockModule.__emit("result", {
      results: [{ transcript: "buy oat milk" }],
      isFinal: false,
    });

    expect(onTranscript).toHaveBeenCalledWith("buy oat milk", false);
  });

  it("stop tap ends the native session and, once `end` fires, commits the transcript as final and returns to idle", async () => {
    const { onTranscript } = renderVoiceButton();
    await tapStart();
    mockModule.__emit("result", { results: [{ transcript: "call mom" }], isFinal: true });
    onTranscript.mockClear();

    tap(screen.getByLabelText("Stop dictation"));
    expect(mockModule.stop).toHaveBeenCalledTimes(1);
    // Real device: `end` arrives asynchronously after stop(); simulate it.
    mockModule.__emit("end");

    expect(onTranscript).toHaveBeenCalledWith("call mom", true);
    await waitFor(() => screen.getByLabelText("Start dictation"));
  });

  it("permission denied (and not re-askable) shows the persistent permission error sheet with an 'Open App Settings' action", async () => {
    mockModule.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    renderVoiceButton();
    tap(screen.getByLabelText("Start dictation"));

    // getByText normalizes the rendered text's whitespace (newline → single
    // space) but does not touch the query string, so match with the
    // collapsed form here rather than the source string's literal "\n".
    await waitFor(() =>
      expect(
        screen.getByText("Microphone permission is required for voice input. If the system dialog did not appear, enable it manually in App Settings."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Open App Settings")).toBeTruthy();
    // Never reaches start() — permission gate blocks it.
    expect(mockModule.start).not.toHaveBeenCalled();
  });

  it("no speech service detected on device shows the terminal no-service sheet with install/retry/diagnostics actions", async () => {
    // First tap starts fine (default pinned recognizer)...
    renderVoiceButton();
    await tapStart();
    // ...then every recognizer, including detection's own probes, reports
    // nothing usable — the code-5 (no-service) ladder with no saved pkg runs
    // detection, which finds nothing.
    mockModule.getSpeechRecognitionServices.mockReturnValue([]);
    mockModule.getSupportedLocales.mockRejectedValue(new Error("no service"));

    mockModule.__emit("error", { code: 5, error: "client" });

    await waitFor(() =>
      expect(
        screen.getByText(
          "No working speech service found on this device. Install a speech service below, or copy diagnostics for details.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Install Speech Services by Google")).toBeTruthy();
    expect(screen.getByText("Retry Detection")).toBeTruthy();
    expect(screen.getByText("Copy diagnostics")).toBeTruthy();
  });

  it("stopAndFlush (imperative handle) commits the in-progress transcript immediately, without waiting for the native `end` event", async () => {
    const { onTranscript, ref } = renderVoiceButton();
    await tapStart();
    mockModule.__emit("result", { results: [{ transcript: "left off here" }], isFinal: false });
    onTranscript.mockClear();

    ref.current!.stopAndFlush();

    // Committed synchronously from JS state — no `end` event required.
    expect(onTranscript).toHaveBeenCalledWith("left off here", true);
    expect(mockModule.stop).toHaveBeenCalledTimes(1);
  });

  it("stopAndFlush is a no-op when not recording", () => {
    const { onTranscript, ref } = renderVoiceButton();
    ref.current!.stopAndFlush();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(mockModule.stop).not.toHaveBeenCalled();
  });

  it("disabled prop disables the button and blocks tap-to-start", async () => {
    renderVoiceButton({ disabled: true });
    const btn = screen.getByLabelText("Start dictation");
    tap(btn);
    // handleToggle's very first line bails on `disabled` — nothing starts.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockModule.start).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Stop dictation")).toBeNull();
  });

  it("max-recording safety cap auto-stops the session after MAX_RECORDING_MS", async () => {
    vi.useFakeTimers();
    try {
      renderVoiceButton();
      fireEvent.click(screen.getByLabelText("Start dictation"));
      // Flush the permission/AsyncStorage/start microtask chain under fake timers.
      await vi.runOnlyPendingTimersAsync();
      expect(mockModule.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      expect(mockModule.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Negative-control evidence ───────────────────────────────────────────
  // For the 3 tests below, the assertion was temporarily inverted/broken to
  // confirm it can actually fail, then restored. See PR description / commit
  // message for which three and what was changed (result-event wiring,
  // permission-denied sheet text, no-service sheet text) — reproducible by
  // swapping the expected string/callback args below and re-running.
});
