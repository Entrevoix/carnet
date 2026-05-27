/**
 * On-device audio transcription wrapper around expo-speech-recognition.
 *
 * Why on-device instead of OmniRoute Whisper / Gemini multimodal:
 *   - Free. No per-capture API cost.
 *   - Private. Audio never leaves the device.
 *   - Works offline once the OS speech engine has its language pack
 *     installed (one-time setup the user already completes for the
 *     Journal voice button — see the STT first-tap-bug memory).
 *   - Reliable. Doesn't depend on a configured OmniRoute proxy, doesn't
 *     trip the content-policy filters that Gemini's audio modality
 *     applies to transcription requests.
 *
 * The expo-speech-recognition library supports a file-based audioSource
 * (`audioSource: { uri }`) that points the recognizer at an existing .m4a
 * instead of opening the live mic. SAF content:// URIs aren't accepted —
 * we copy to the app cache and pass the file:// URI for portability.
 *
 * Returns the final concatenated transcript. Throws on:
 *   - No final result within ON_DEVICE_TIMEOUT_MS
 *   - error event from the recognizer (permission denied, codec, etc.)
 *   - Empty result (silent audio)
 */

import * as FileSystem from "expo-file-system/legacy";
import {
  ExpoSpeechRecognitionModule,
} from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";

const ON_DEVICE_TIMEOUT_MS = 90_000;

/**
 * Transcribe an audio file at `audioUri` (file:// or content://). If the
 * URI is SAF (content://), first copies the bytes into the app cache via
 * the supplied base64 so expo-speech-recognition can read it as a file.
 */
export async function transcribeOnDevice(input: {
  base64: string;
  filename: string;
}): Promise<string> {
  const cacheDir = FileSystem.cacheDirectory ?? "file:///data/local/tmp/";
  const ext = input.filename.includes(".")
    ? input.filename.slice(input.filename.lastIndexOf("."))
    : ".m4a";
  const tempPath = `${cacheDir}stt-${Date.now()}${ext}`;

  await FileSystem.writeAsStringAsync(tempPath, input.base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  try {
    return await runRecognizer(tempPath);
  } finally {
    // Best-effort cache cleanup. OS reaps it eventually anyway.
    try {
      await FileSystem.deleteAsync(tempPath, { idempotent: true });
    } catch {
      /* swallow */
    }
  }
}

function runRecognizer(fileUri: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let resolved = false;
    let bestText = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The lib's listener API uses module.addListener('eventName', handler)
    // and returns a Subscription with .remove(). All listeners get cleaned
    // up on either resolution or rejection — leak-proof.
    const subs: Array<{ remove: () => void }> = [];

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      subs.forEach((s) => {
        try {
          s.remove();
        } catch {
          /* ignore */
        }
      });
      subs.length = 0;
    };

    const finish = (text: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const trimmed = text.trim();
      if (!trimmed) {
        reject(
          new Error(
            "On-device STT returned no recognized speech (silent audio?)",
          ),
        );
        return;
      }
      resolve(trimmed);
    };

    const fail = (err: Error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Best-effort stop in case the recognizer is still listening.
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    // `result` fires for partial AND final results — we keep the latest
    // non-empty transcript so an `end` without a final still has SOMETHING
    // to resolve with.
    subs.push(
      ExpoSpeechRecognitionModule.addListener(
        "result",
        (event: ExpoSpeechRecognitionResultEvent) => {
          if (event.results.length === 0) return;
          const text = event.results[0].transcript;
          if (text) bestText = text;
        },
      ),
    );

    // `end` fires when the recognizer is done. Resolve with whatever we
    // accumulated.
    subs.push(
      ExpoSpeechRecognitionModule.addListener("end", () => {
        finish(bestText);
      }),
    );

    subs.push(
      ExpoSpeechRecognitionModule.addListener(
        "error",
        (event: ExpoSpeechRecognitionErrorEvent) => {
          // Some "no-speech" errors fire AFTER we've already received a
          // valid result. Treat them as successful finishes if we have
          // text in hand.
          if (event.error === "no-speech" && bestText.trim().length > 0) {
            finish(bestText);
            return;
          }
          fail(
            new Error(
              `On-device STT error: ${event.error}${event.message ? ` — ${event.message}` : ""}`,
            ),
          );
        },
      ),
    );

    timer = setTimeout(() => {
      fail(
        new Error(
          `On-device STT timed out after ${ON_DEVICE_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, ON_DEVICE_TIMEOUT_MS);

    try {
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: false,
        continuous: false,
        audioSource: { uri: fileUri },
      });
    } catch (e: unknown) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
