import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the native decoder facade ──────────────────────────────────────────
vi.mock("./audioDecoder", () => ({
  isAvailable: vi.fn(),
  decodeToWav: vi.fn(),
}));

// ── Mock the filesystem (legacy API the module imports) ─────────────────────
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock expo-speech-recognition ────────────────────────────────────────────
// addListener stores each handler by event name in a hoisted map; tests then
// set start() to fire those handlers, driving runRecognizer to resolve/reject
// without a real native recognizer.
const { speechListeners } = vi.hoisted(() => ({
  speechListeners: {} as Record<string, (event: unknown) => void>,
}));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    addListener: vi.fn((event: string, handler: (e: unknown) => void) => {
      speechListeners[event] = handler;
      return { remove: vi.fn() };
    }),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

import * as FileSystem from "expo-file-system/legacy";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionErrorCode,
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";
import * as audioDecoder from "./audioDecoder";
import { transcribeOnDevice } from "./audioTranscribeOnDevice";

/** Make start() emit a final result then `end`, so runRecognizer resolves. */
function driveSuccess(transcript: string): void {
  // Typed against the real event so a future library shape change (e.g. a
  // renamed `results`/`transcript`) breaks this test at compile time rather
  // than passing while production silently reads undefined.
  const event: ExpoSpeechRecognitionResultEvent = {
    isFinal: true,
    results: [{ transcript, confidence: 1, segments: [] }],
  };
  vi.mocked(ExpoSpeechRecognitionModule.start).mockImplementation(() => {
    speechListeners.result?.(event);
    speechListeners.end?.(undefined);
  });
}

/** Make start() emit a hard error, so runRecognizer rejects. */
function driveError(error: ExpoSpeechRecognitionErrorCode, message = ""): void {
  const event: ExpoSpeechRecognitionErrorEvent = { error, message };
  vi.mocked(ExpoSpeechRecognitionModule.start).mockImplementation(() => {
    speechListeners.error?.(event);
  });
}

/** The single `audioSource.uri` the recognizer was started with. */
function recognizerInputUri(): string | undefined {
  const opts = vi.mocked(ExpoSpeechRecognitionModule.start).mock.calls[0]?.[0] as
    | { audioSource?: { uri?: string } }
    | undefined;
  return opts?.audioSource?.uri;
}

/** Paths passed to FileSystem.deleteAsync, in call order. */
function deletedPaths(): string[] {
  return vi
    .mocked(FileSystem.deleteAsync)
    .mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks(); // clears call history; factory implementations persist
  for (const k of Object.keys(speechListeners)) delete speechListeners[k];
});

describe("transcribeOnDevice — decode-vs-fallback wiring", () => {
  it("decodes to WAV and feeds the decoded file to the recognizer when the native decoder is available", async () => {
    vi.mocked(audioDecoder.isAvailable).mockReturnValue(true);
    vi.mocked(audioDecoder.decodeToWav).mockResolvedValue("decoded");
    driveSuccess("hello world");

    const text = await transcribeOnDevice({
      base64: "AAAA",
      filename: "clip.mp3",
    });

    expect(text).toBe("hello world");

    const rawPath = vi.mocked(FileSystem.writeAsStringAsync).mock
      .calls[0][0] as string;
    // A real extension is preserved on the raw temp file.
    expect(rawPath.endsWith("-input.mp3")).toBe(true);

    // Decoder ran with (rawPath, wavPath) and the recognizer got the WAV.
    expect(audioDecoder.decodeToWav).toHaveBeenCalledTimes(1);
    const [decIn, decOut] = vi.mocked(audioDecoder.decodeToWav).mock
      .calls[0] as [string, string];
    expect(decIn).toBe(rawPath);
    expect(decOut.endsWith("-decoded.wav")).toBe(true);
    expect(recognizerInputUri()).toBe(decOut);

    // Both temp files cleaned up on success.
    expect(deletedPaths()).toContain(rawPath);
    expect(deletedPaths()).toContain(decOut);
  });

  it("falls back to the raw file (no decode) when the native module is unavailable", async () => {
    vi.mocked(audioDecoder.isAvailable).mockReturnValue(false);
    driveSuccess("transcript");

    const text = await transcribeOnDevice({
      base64: "AAAA",
      filename: "note.m4a",
    });

    expect(text).toBe("transcript");
    expect(audioDecoder.decodeToWav).not.toHaveBeenCalled();

    const rawPath = vi.mocked(FileSystem.writeAsStringAsync).mock
      .calls[0][0] as string;
    // Recognizer reads the RAW file, not a decoded WAV.
    expect(recognizerInputUri()).toBe(rawPath);

    // Both paths still cleaned up — the never-written wav delete is a
    // best-effort idempotent no-op.
    expect(deletedPaths()).toContain(rawPath);
    expect(deletedPaths().some((p) => p.endsWith("-decoded.wav"))).toBe(true);
  });

  it("cleans up both temp files even when the recognizer errors", async () => {
    vi.mocked(audioDecoder.isAvailable).mockReturnValue(true);
    vi.mocked(audioDecoder.decodeToWav).mockResolvedValue("decoded");
    driveError("audio-capture", "mic busy");

    await expect(
      transcribeOnDevice({ base64: "AAAA", filename: "clip.m4a" }),
    ).rejects.toThrow(/audio-capture/);

    const rawPath = vi.mocked(FileSystem.writeAsStringAsync).mock
      .calls[0][0] as string;
    expect(deletedPaths()).toContain(rawPath);
    expect(deletedPaths().some((p) => p.endsWith("-decoded.wav"))).toBe(true);
  });

  it("defaults the temp-file extension to .m4a for a degenerate (trailing-dot) filename", async () => {
    vi.mocked(audioDecoder.isAvailable).mockReturnValue(false);
    driveSuccess("ok");

    await transcribeOnDevice({ base64: "AAAA", filename: "voicememo." });

    const rawPath = vi.mocked(FileSystem.writeAsStringAsync).mock
      .calls[0][0] as string;
    expect(rawPath.endsWith("-input.m4a")).toBe(true);
  });
});
