/**
 * JS-side facade for the AudioDecoder native module. Wraps NativeModules
 * with the same Platform / null-checked getNative pattern as
 * captureNotification.ts so Expo Go / iOS / missing-bridge cases throw a
 * friendly error instead of crashing on .decodeToWav.
 *
 * The underlying native module (plugins/withAudioDecoder.js → emitted
 * Kotlin) decodes any Android-supported audio container (AAC, MP3, FLAC,
 * Vorbis, Opus, AMR, WAV) into 16-bit mono PCM at 16 kHz, wrapped in a
 * standard RIFF/WAVE header. Used by audioTranscribeOnDevice to translate
 * AAC-in-MP4 recordings into the format expo-speech-recognition's file
 * mode requires.
 */

import { NativeModules, Platform } from "react-native";

interface AudioDecoderNative {
  decodeToWav: (inputUri: string, outputUri: string) => Promise<string>;
}

function getNative(): AudioDecoderNative | null {
  // Module is Android-only; iOS will never have it registered.
  if (Platform.OS !== "android") return null;
  const mod = (NativeModules as Record<string, unknown>).AudioDecoder;
  if (!mod) return null;
  return mod as AudioDecoderNative;
}

export function isAvailable(): boolean {
  return getNative() !== null;
}

/**
 * Decode any Android-supported audio container at `inputUri` (must be a
 * file:// path) into a PCM 16 kHz mono WAV file at `outputUri`. Returns
 * the output URI on success.
 *
 * Throws if the native module is unavailable (Expo Go, iOS, missing
 * bridge registration). Caller should check `isAvailable()` first if
 * they want a graceful fallback.
 */
export async function decodeToWav(
  inputUri: string,
  outputUri: string,
): Promise<string> {
  const native = getNative();
  if (!native) {
    throw new Error(
      "AudioDecoder native module is not available in this build (Expo Go / iOS / missing bridge).",
    );
  }
  return native.decodeToWav(inputUri, outputUri);
}
