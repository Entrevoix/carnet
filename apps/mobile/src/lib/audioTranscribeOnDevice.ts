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
import * as audioDecoder from "./audioDecoder";
import { STT_MODEL_MISSING_MESSAGE } from "../voice/sttOnboarding";

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
  // Require a real, non-leading dot with at least one char after it. Guards
  // trailing-dot ("clip.") and dotfile (".hidden") names that would yield a
  // degenerate extension; defaults to .m4a (the app's own capture format).
  // The native decoder sniffs the container by content, but the fallback
  // path hands this filename straight to the recognizer.
  const dot = input.filename.lastIndexOf(".");
  const ext =
    dot > 0 && dot < input.filename.length - 1
      ? input.filename.slice(dot)
      : ".m4a";
  const ts = Date.now();
  const rawPath = `${cacheDir}stt-${ts}-input${ext}`;
  const wavPath = `${cacheDir}stt-${ts}-decoded.wav`;

  await FileSystem.writeAsStringAsync(rawPath, input.base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  try {
    // Decode the raw container (AAC, MP3, etc.) to 16 kHz mono PCM WAV
    // — expo-speech-recognition's file mode reads input as raw PCM and
    // can't decode containers. Without this step, AAC files emit
    // no-speech because the recognizer interprets the encoded bytes as
    // noise samples.
    //
    // Graceful fallback: if the native module isn't registered (Expo Go,
    // iOS, missing bridge), pass the raw file. Recognizer will probably
    // emit no-speech for AAC inputs in that case, but PCM/WAV inputs
    // would still work.
    let recognizerInput = rawPath;
    if (audioDecoder.isAvailable()) {
      await audioDecoder.decodeToWav(rawPath, wavPath);
      recognizerInput = wavPath;
    }
    return await runRecognizer(recognizerInput);
  } finally {
    // Best-effort cache cleanup for BOTH temp files. OS reaps it
    // eventually anyway, but cleaning eagerly keeps the cache dir
    // small across many transcriptions.
    for (const p of [rawPath, wavPath]) {
      try {
        await FileSystem.deleteAsync(p, { idempotent: true });
      } catch {
        /* swallow */
      }
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
          // No-model / no-service class: on a fresh device the on-device speech
          // model isn't downloaded, so the recognizer dead-ends here (code 12 /
          // "no service found"). The raw error is cryptic — remap ONLY this
          // class to an actionable message that points at the Journal voice
          // dictation download flow. Other errors pass through.
          const noModel = /no service|language|not.?support|unavailable/i.test(
            `${event.error} ${event.message ?? ""}`,
          );
          if (noModel) {
            fail(new Error(STT_MODEL_MISSING_MESSAGE));
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
