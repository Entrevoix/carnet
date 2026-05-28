# Plan: AAC decoder bridge for on-device STT

## Summary
A native Android module that decodes the m4a/AAC audio files carnet records into 16kHz mono PCM WAV, so `expo-speech-recognition`'s file-mode recognizer can actually understand them. Closes the on-device-STT loop that landed empty-handed in PR #22: the recognizer rejects AAC bytes as raw PCM and emits `no-speech`. After this PR, the Transcribe button works end-to-end with no network, no API key, no proxy.

## User Story
As a carnet user who recorded an audio note,
I want to tap Transcribe and see the actual transcript,
So that the audio I just captured is searchable text in my vault — without OmniRoute, without Whisper, without a proxy.

## Problem → Solution
**Current:** AudioCaptureScreen writes AAC-in-MP4 (`audio/mp4`) for size and universal playback. expo-speech-recognition's `audioSource: { uri }` expects raw 16-bit linear PCM. Pointing it at our m4a makes it read encoded AAC bytes as PCM samples — pure noise, `no-speech` error every time. The on-device path is currently scaffolded but non-functional.

**Desired:** A thin native module decodes m4a → PCM WAV before the recognizer sees the file. The .m4a stays as the canonical playback artifact (player still works, sync still works, Obsidian still plays it). A throwaway WAV lives in the cache only long enough to feed the recognizer, then gets deleted.

## Metadata
- **Complexity:** Large
- **Source PRD:** N/A (follow-up to PR #22)
- **PRD Phase:** N/A
- **Estimated Files:** 3 new + 2 modified + ~200 LOC of Kotlin emitted by plugin
- **Confidence Score:** 8/10 — pattern mirrors PR #19's withCaptureNotification exactly (Expo plugin + Kotlin RN bridge + JS facade). MediaCodec API is documented but easy to get wrong on buffer handling; first build will likely crash on resource cleanup or buffer-size assumptions, expect 1-2 iteration cycles on the Kotlin.

---

## UX Design

### Before (today, post-PR-22)
```
Audio recent → tap Transcribe
  → "Transcribing audio…" spinner
  → 3-5s later:
  → "Transcribe failed: On-device STT error: no-speech — no speech detected"
  (Even on clearly-spoken audio. Recognizer can't decode AAC.)
```

### After
```
Audio recent → tap Transcribe
  → "Transcribing audio…" spinner
  → ~2-5s later (decode + recognize on a typical 30s clip):
  → ## Transcript section appears in the rendered body with the real text
```

### Interaction Changes
| Touchpoint | Before | After |
|---|---|---|
| Tap Transcribe on shared-audio note | "no-speech" error | Transcript appears |
| Auto-transcribe toggle (PR #21) flipped on + record audio | Saved screen banner: "Auto-transcribe failed: no-speech" | Saved screen banner clears silently; transcript on next view |
| Tap Transcribe on a non-m4a (e.g. share-audio of a .mp3 podcast clip) | "no-speech" | Works (MediaExtractor handles MP3 too) |

Internal change otherwise. No new screens, no new buttons, no Settings additions.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/plugins/withCaptureNotification.js` | all | Reference plugin for the Kotlin-emission pattern, withMainApplication injection, the 4-pattern regex for SDK shapes (PR #22). Same shape, different module. |
| P0 | `apps/mobile/src/lib/captureNotification.ts` | all | Reference JS facade — isAvailable / getNative / promise-wrapped NativeModules calls. Same shape for audioDecoder.ts. |
| P0 | `apps/mobile/src/lib/audioTranscribeOnDevice.ts` | all | The consumer. Currently writes base64 to cache + passes file:// to recognizer; needs an intermediate decode step. |
| P0 | `apps/mobile/scripts/verify-notification-and-widget-prebuild.sh` | all | Reference for the prebuild-verification script pattern. New script `verify-audio-decoder-prebuild.sh` follows it. |
| P0 | `apps/mobile/app.json` | plugins array, android.permissions | Where to register the new plugin (no new perms needed — MediaCodec is unprivileged). |
| P1 | `apps/mobile/src/lib/captureNotification.test.ts` | all | Reference for the JS facade unit-test shape (vi.doMock for react-native, branched isAvailable cases). |
| P1 | `apps/mobile/src/lib/writer.ts` | 32-61 (resolveRoot), 92-115 (safLastSegment) | Reference for the SAF file:// vs content:// URI handling — the decoder's input may be either. |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Android MediaExtractor + MediaCodec | developer.android.com/reference/android/media/MediaExtractor | `setDataSource(path)`, iterate `getTrackFormat(i)` to find audio, `selectTrack`, then loop `readSampleData` + `dequeue{Input,Output}Buffer` |
| WAV header format | RIFF/WAVE spec | 44-byte header: `RIFF<size-8>WAVEfmt <16><1><channels><rate><byteRate><blockAlign><bits>data<dataSize>`. Little-endian. PCM 16-bit linear is format 1. |
| Linear-interp downsample | None — basic DSP | For source rate `Fs`, target rate `Ft`, compute `step = Fs/Ft`, sample at `i*step` indices with linear interp between neighbors. Quality is fine for STT; high-frequency aliasing artifacts are below the recognizer's sensitivity. |

---

## Discovery Table

| Category | File:Lines | Pattern |
|---|---|---|
| Expo plugin shape (withMainApplication + withDangerousMod) | `plugins/withCaptureNotification.js:411-560` | Emits Kotlin files via `fs.writeFileSync` inside `withDangerousMod`; injects `add(Package())` via `withMainApplication` with 4-pattern regex |
| ReactPackage registration | `plugins/withCaptureNotification.js:capturePackageKt` | One Kotlin class extending `ReactPackage`, returning `listOf(Module(reactContext))` |
| NativeModule + Promise-based API | `plugins/withCaptureNotification.js:captureNotificationModuleKt` | `@ReactMethod fun start(promise: Promise) { try { ...; promise.resolve(...) } catch (e) { promise.reject(...) } }` |
| JS facade with Platform/null guards | `apps/mobile/src/lib/captureNotification.ts:23-29` | `function getNative(): ... \| null { if (Platform.OS !== "android") return null; const mod = (NativeModules as ...).X; return mod ?? null; }` |
| Cache file path pattern | `apps/mobile/src/lib/audioTranscribeOnDevice.ts:35-42` | `${cacheDir}stt-${Date.now()}-${name}${ext}`, delete in finally |
| Verify-script shape | `scripts/verify-notification-and-widget-prebuild.sh` | Clean prebuild → assert emitted files + manifest lines + MainApplication injection |

---

## Patterns to Mirror

### KOTLIN_DECODER_MODULE (new, ~200 LOC emitted by plugin)
The core native decode + downsample + WAV-wrap. Two public methods: `decodeToWav(inputUri, outputUri)` and `isAvailable()` (always true on Android; reserved for future feature flags).

```kotlin
package ${packageName}.audiodecoder

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/**
 * Decodes any audio format Android's MediaExtractor supports
 * (AAC, MP3, FLAC, Vorbis, Opus, AMR, WAV) into 16-bit mono PCM at
 * 16 kHz and writes a standard RIFF/WAVE file.
 *
 * Target format is fixed because the only consumer is
 * expo-speech-recognition, which expects exactly that shape.
 *
 * In-memory accumulation of the decoded PCM — fine for typical
 * voice notes (5 min ≈ 9.6 MB). For multi-hour recordings switch to
 * streaming write; documented as a known limit.
 */
class AudioDecoderModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "AudioDecoder"

  @ReactMethod
  fun decodeToWav(inputUri: String, outputUri: String, promise: Promise) {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    try {
      val inputPath = Uri.parse(inputUri).path
        ?: return promise.reject("E_BAD_INPUT", "Input URI has no path")
      extractor.setDataSource(inputPath)

      // Find the audio track.
      var trackIdx = -1
      var trackFormat: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        if (format.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
          trackIdx = i
          trackFormat = format
          break
        }
      }
      if (trackIdx < 0 || trackFormat == null) {
        return promise.reject("E_NO_AUDIO_TRACK", "No audio track in input")
      }
      extractor.selectTrack(trackIdx)

      val srcSampleRate = trackFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      val srcChannels = trackFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      val mime = trackFormat.getString(MediaFormat.KEY_MIME)!!

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(trackFormat, null, null, 0)
      decoder.start()

      // Decode loop. Accumulate output PCM into a growable buffer.
      val pcmOut = ByteArrayOutputStream()
      val bufferInfo = MediaCodec.BufferInfo()
      var inputEos = false
      var outputEos = false
      val timeoutUs = 10_000L

      while (!outputEos) {
        if (!inputEos) {
          val inIdx = decoder.dequeueInputBuffer(timeoutUs)
          if (inIdx >= 0) {
            val inBuf = decoder.getInputBuffer(inIdx)!!
            val sampleSize = extractor.readSampleData(inBuf, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              inputEos = true
            } else {
              decoder.queueInputBuffer(
                inIdx, 0, sampleSize, extractor.sampleTime, 0
              )
              extractor.advance()
            }
          }
        }
        val outIdx = decoder.dequeueOutputBuffer(bufferInfo, timeoutUs)
        if (outIdx >= 0) {
          if (bufferInfo.size > 0) {
            val outBuf = decoder.getOutputBuffer(outIdx)!!
            outBuf.position(bufferInfo.offset)
            outBuf.limit(bufferInfo.offset + bufferInfo.size)
            val chunk = ByteArray(bufferInfo.size)
            outBuf.get(chunk)
            pcmOut.write(chunk)
          }
          decoder.releaseOutputBuffer(outIdx, false)
          if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
            outputEos = true
          }
        }
        // INFO_TRY_AGAIN_LATER / INFO_OUTPUT_FORMAT_CHANGED are benign;
        // loop continues.
      }

      val rawPcm = pcmOut.toByteArray()
      val mono = if (srcChannels == 1) rawPcm else mixToMono(rawPcm, srcChannels)
      val downsampled =
        if (srcSampleRate == 16000) mono
        else downsampleLinear(mono, srcSampleRate, 16000)
      val wav = wrapInWavHeader(downsampled, 16000, 1, 16)

      val outPath = Uri.parse(outputUri).path
        ?: return promise.reject("E_BAD_OUTPUT", "Output URI has no path")
      FileOutputStream(outPath).use { it.write(wav) }

      promise.resolve(outputUri)
    } catch (e: Exception) {
      promise.reject("E_DECODE_FAIL", e.message ?: "Unknown decode error", e)
    } finally {
      try { decoder?.stop() } catch (_: Exception) {}
      try { decoder?.release() } catch (_: Exception) {}
      try { extractor.release() } catch (_: Exception) {}
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private fun mixToMono(pcm: ByteArray, channels: Int): ByteArray {
    // 16-bit samples. Average across channels into a single channel.
    val src = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val totalFrames = src.remaining() / channels
    val out = ByteArray(totalFrames * 2)
    val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
    for (f in 0 until totalFrames) {
      var sum = 0
      for (c in 0 until channels) sum += src.get().toInt()
      bb.putShort((sum / channels).toShort())
    }
    return out
  }

  private fun downsampleLinear(
    pcm: ByteArray,
    srcRate: Int,
    dstRate: Int,
  ): ByteArray {
    // Linear interpolation. Quality is fine for 16 kHz STT input; high-
    // frequency aliasing is below the recognizer's sensitivity envelope.
    val src = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val srcFrames = src.remaining()
    val ratio = srcRate.toDouble() / dstRate.toDouble()
    val dstFrames = (srcFrames / ratio).toInt()
    val out = ByteArray(dstFrames * 2)
    val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until dstFrames) {
      val pos = i * ratio
      val idx = pos.toInt()
      val frac = pos - idx
      val s0 = src.get(idx).toDouble()
      val s1 = if (idx + 1 < srcFrames) src.get(idx + 1).toDouble() else s0
      val interp = (s0 + (s1 - s0) * frac).toInt()
      bb.putShort(interp.toShort())
    }
    return out
  }

  private fun wrapInWavHeader(
    pcm: ByteArray,
    sampleRate: Int,
    channels: Int,
    bitsPerSample: Int,
  ): ByteArray {
    val byteRate = sampleRate * channels * bitsPerSample / 8
    val blockAlign = channels * bitsPerSample / 8
    val dataSize = pcm.size
    val totalSize = 36 + dataSize
    val out = ByteArray(44 + dataSize)
    val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
    bb.put("RIFF".toByteArray())
    bb.putInt(totalSize)
    bb.put("WAVE".toByteArray())
    bb.put("fmt ".toByteArray())
    bb.putInt(16)                  // PCM fmt chunk size
    bb.putShort(1)                 // PCM format
    bb.putShort(channels.toShort())
    bb.putInt(sampleRate)
    bb.putInt(byteRate)
    bb.putShort(blockAlign.toShort())
    bb.putShort(bitsPerSample.toShort())
    bb.put("data".toByteArray())
    bb.putInt(dataSize)
    System.arraycopy(pcm, 0, out, 44, dataSize)
    return out
  }
}
```

### KOTLIN_PACKAGE_REGISTRATION (~30 LOC emitted by plugin)
```kotlin
package ${packageName}.audiodecoder

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

class AudioDecoderPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AudioDecoderModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
```

### JS_FACADE (apps/mobile/src/lib/audioDecoder.ts, ~60 LOC)
```ts
/**
 * JS-side facade for the AudioDecoder native module. Wraps NativeModules
 * with the same Platform / null-checked getNative pattern as
 * captureNotification.ts so Expo Go / iOS / missing-bridge cases throw a
 * friendly error instead of crashing on .decodeToWav.
 */

import { NativeModules, Platform } from "react-native";

interface AudioDecoderNative {
  decodeToWav: (inputUri: string, outputUri: string) => Promise<string>;
}

function getNative(): AudioDecoderNative | null {
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
 * Throws if the native module is unavailable (Expo Go, iOS) — caller
 * should check isAvailable() first if they want a graceful fallback.
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
```

### PLUGIN_SHAPE (apps/mobile/plugins/withAudioDecoder.js)
Direct copy of withCaptureNotification.js's shape — only the package suffix (`audiodecoder` vs `notification`), the class names, and the emitted Kotlin bodies differ. Includes:
- TODO header (same pattern as the notification plugin) flagging the in-place Kotlin templates
- Stage 1: withAndroidManifest — no permissions needed
- Stage 2: withMainApplication — same 4-pattern regex + applyAdd/localAdd discriminator from PR #22's fix
- Stage 3: withDangerousMod — emit AudioDecoderModule.kt + AudioDecoderPackage.kt under `android/app/src/main/java/{packagePath}/audiodecoder/`
- Postcondition: throw if `AudioDecoderPackage()` injection regex misses (same loud-fail pattern as PR #22)

### TRANSCRIBE_INTEGRATION (audioTranscribeOnDevice.ts update)
```ts
import * as audioDecoder from "./audioDecoder";

export async function transcribeOnDevice(input: {
  base64: string;
  filename: string;
}): Promise<string> {
  const cacheDir = FileSystem.cacheDirectory ?? "file:///data/local/tmp/";
  const ext = input.filename.includes(".")
    ? input.filename.slice(input.filename.lastIndexOf("."))
    : ".m4a";
  const ts = Date.now();
  const rawPath = `${cacheDir}stt-${ts}-input${ext}`;
  const wavPath = `${cacheDir}stt-${ts}-decoded.wav`;

  await FileSystem.writeAsStringAsync(rawPath, input.base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  try {
    // Decode AAC/MP3/etc → 16 kHz mono PCM WAV. The recognizer only
    // accepts PCM; without this step it reads encoded bytes as noise
    // and emits no-speech.
    let recognizerInput = rawPath;
    if (audioDecoder.isAvailable()) {
      await audioDecoder.decodeToWav(rawPath, wavPath);
      recognizerInput = wavPath;
    } else {
      // Fallback: hope the input is already WAV. If not, recognizer
      // will emit no-speech and the caller surfaces the error.
    }

    return await runRecognizer(recognizerInput);
  } finally {
    for (const p of [rawPath, wavPath]) {
      try { await FileSystem.deleteAsync(p, { idempotent: true }); } catch {}
    }
  }
}
```

### VERIFY_SCRIPT (apps/mobile/scripts/verify-audio-decoder-prebuild.sh)
Mirror of verify-notification-and-widget-prebuild.sh:
- Clean prebuild
- Assert AudioDecoderModule.kt + AudioDecoderPackage.kt emitted
- Assert AndroidManifest unchanged (no perms / receivers needed)
- Assert MainApplication includes `add(AudioDecoderPackage())` call site

### JS_FACADE_TESTS (audioDecoder.test.ts)
Same 5-case shape as captureNotification.test.ts:
- isAvailable() false on iOS
- isAvailable() false when module missing (Expo Go)
- isAvailable() true on Android with module registered
- decodeToWav() throws friendly error when module missing
- decodeToWav() delegates to native.decodeToWav with right args

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/plugins/withAudioDecoder.js` | CREATE | Emits Kotlin + manifest mods + MainApplication injection |
| `apps/mobile/src/lib/audioDecoder.ts` | CREATE | JS facade for the native bridge |
| `apps/mobile/src/lib/audioDecoder.test.ts` | CREATE | 5 facade tests (iOS / Expo Go / missing module / Android / delegation) |
| `apps/mobile/scripts/verify-audio-decoder-prebuild.sh` | CREATE | Plugin regression check |
| `apps/mobile/app.json` | UPDATE | Register the new plugin in the plugins array |
| `apps/mobile/src/lib/audioTranscribeOnDevice.ts` | UPDATE | Decode step before runRecognizer + cleanup of two cache files |

## NOT Building
- **iOS counterpart.** AudioDecoder is Android-only via MediaCodec. iOS would need a separate AVAudioConverter-based module. Out of scope; carnet is Android-first.
- **Streaming decode for multi-hour audio.** In-memory PCM buffer caps comfortable usage at ~30 min (≈ 57 MB). Beyond that, OOM risk. Document the limit; revisit if a user reports it.
- **High-quality polyphase resampler.** Linear-interp downsample is "good enough" for STT — the recognizer is tolerant of aliasing artifacts in the inaudible high-frequency range. Polyphase would add ~200 LOC for negligible accuracy gain.
- **Output formats other than 16 kHz mono PCM WAV.** Only consumer is the recognizer; no need for configurability.
- **Decode-without-resample fast path** when source is already 16 kHz mono. ~5 lines of code save but the recordings are 44.1 kHz, so this branch never fires in practice. Add only if a future code path records at the right rate natively.
- **Cache eviction policy.** Each transcribe writes ≤ ~60 MB to cache (m4a + decoded WAV) then deletes both in finally. OS reaps cache on low-memory anyway. No manual cleanup.
- **Concurrent transcribe protection.** If the user taps Transcribe twice rapidly the cache filenames collide (same `Date.now()`-derived prefix to the millisecond). Add a counter to the filename if it becomes a real problem. Edge case; current UX disables the button while transcribing.

---

## Step-by-Step Tasks

### Task 1: Write `withAudioDecoder.js`
- **ACTION:** Create the Expo config plugin.
- **IMPLEMENT:** Per `PLUGIN_SHAPE`. Three stages:
  1. `withAndroidManifest` — no-op (no permissions, no service, no receiver to declare)
  2. `withMainApplication` — same 4-pattern regex + applyAdd/localAdd discriminator from PR #22's withCaptureNotification. Inject `add(AudioDecoderPackage())` + import line.
  3. `withDangerousMod` — emit `AudioDecoderModule.kt` + `AudioDecoderPackage.kt` under `android/app/src/main/java/{packagePath}/audiodecoder/`.
- **MIRROR:** `apps/mobile/plugins/withCaptureNotification.js` — direct copy of the SDK-shape regex matching + add() injection + postcondition throw.
- **IMPORTS:** `fs`, `path`, `{ withAndroidManifest, withDangerousMod, withMainApplication }` from `@expo/config-plugins`.
- **GOTCHA:**
  - The MainApplication injection postcondition MUST throw on miss (PR #22 lesson — silent injection failures eat 4 hours of debug time).
  - Stage 1 (manifest) can technically be omitted entirely since we don't need any manifest mutations, but keeping it as a no-op return preserves the shape symmetry with withCaptureNotification.js for future extension.
- **VALIDATE:** Run `scripts/verify-audio-decoder-prebuild.sh` (Task 4) — exits 0 + reports all artifacts.

### Task 2: Create `audioDecoder.ts` JS facade
- **ACTION:** Create `apps/mobile/src/lib/audioDecoder.ts`.
- **IMPLEMENT:** Per `JS_FACADE`.
- **MIRROR:** `apps/mobile/src/lib/captureNotification.ts` — same getNative pattern with Platform + null checks.
- **IMPORTS:** `NativeModules`, `Platform` from `react-native`.
- **GOTCHA:**
  - Throw a specific "not available" error in `decodeToWav` when getNative returns null — caller code paths check `isAvailable()` first if they want a fallback.
- **VALIDATE:** typecheck.

### Task 3: Write facade tests (`audioDecoder.test.ts`)
- **ACTION:** Create `apps/mobile/src/lib/audioDecoder.test.ts`.
- **IMPLEMENT:** 5 cases mirroring `captureNotification.test.ts`:
  - `isAvailable() returns false on iOS even if module present`
  - `isAvailable() returns false when module is missing (Expo Go path)`
  - `isAvailable() returns true when registered on Android`
  - `decodeToWav() throws friendly error when module missing`
  - `decodeToWav() delegates to native.decodeToWav(inputUri, outputUri)`
- **MIRROR:** `apps/mobile/src/lib/captureNotification.test.ts:1-50` — vi.doMock for `react-native`, beforeEach with vi.resetModules.
- **IMPORTS:** `describe`, `expect`, `it`, `vi`, `beforeEach` from `vitest`.
- **GOTCHA:**
  - Use `vi.doMock("react-native", ...)` + `vi.resetModules()` in beforeEach — vi.mock is hoisted globally which breaks per-test platform switching.
- **VALIDATE:** `npm -w @carnet/mobile run test` — 5 new cases pass.

### Task 4: Write verification script
- **ACTION:** Create `apps/mobile/scripts/verify-audio-decoder-prebuild.sh` + `chmod +x`.
- **IMPLEMENT:** Mirror `scripts/verify-notification-and-widget-prebuild.sh`:
  - Clean android/ + run `expo prebuild --platform android`
  - check_file: emitted Kotlin paths under audiodecoder/
  - check_main_app_contains: `import {packageName}.audiodecoder.AudioDecoderPackage` + `add(AudioDecoderPackage())`
- **MIRROR:** `verify-notification-and-widget-prebuild.sh:36-65` — check_file + check_main_app_contains helpers.
- **GOTCHA:** Same SCRIPT_DIR / MOBILE_DIR / ANDROID_DIR pattern. Re-uses ANDROID_HOME from env (PR #22's build-release-apk.sh auto-detect doesn't apply to verify scripts).
- **VALIDATE:** Run the script — exits 0.

### Task 5: Register plugin in app.json
- **ACTION:** Edit `apps/mobile/app.json`.
- **IMPLEMENT:** Add `"./plugins/withAudioDecoder"` to the plugins array, after `./plugins/withCaptureWidget`. No new permissions needed.
- **MIRROR:** Existing plugin entries in app.json (PR #19).
- **GOTCHA:** No permissions to add — MediaCodec is unprivileged. Don't accidentally add `RECORD_AUDIO` (we already have it for recording, but the decoder doesn't need it).
- **VALIDATE:** `expo prebuild --clean --platform android` succeeds without errors.

### Task 6: Wire decoder into `audioTranscribeOnDevice.ts`
- **ACTION:** Edit `apps/mobile/src/lib/audioTranscribeOnDevice.ts`.
- **IMPLEMENT:** Per `TRANSCRIBE_INTEGRATION`. Two cache files now (raw + decoded WAV) — clean both in finally.
- **MIRROR:** Existing transcribeOnDevice structure; insert decode step between cache write and runRecognizer.
- **IMPORTS:** `import * as audioDecoder from "./audioDecoder";`
- **GOTCHA:**
  - Pass `rawPath` (file://) and `wavPath` (file://) — both must be file:// not content://. FileSystem.cacheDirectory always returns file://, safe.
  - decodeToWav may throw on truly malformed inputs (very rare). Let the throw propagate — caller's try/catch surfaces to UI.
  - Don't await deleteAsync — fire and forget. The OS reaps cache anyway.
- **VALIDATE:** Task 7 (on-device).

### Task 7: Validate + on-device
- **ACTION:** `npm -w @carnet/mobile run typecheck`, `npm -w @carnet/mobile run test`, `bash scripts/verify-audio-decoder-prebuild.sh`, then `ANDROID_HOME=... bash scripts/build-release-apk.sh --install`.
- **EXPECT:** 0 type errors. 197 + 5 = 202 tests pass. Verify script all-green. APK builds + installs + on-device QA: record audio → tap Transcribe → see actual text.

---

## Testing Strategy

### Unit Tests
5 new in `audioDecoder.test.ts` for the JS facade. Kotlin decode logic is not unit-testable from vitest — covered by the on-device manual QA.

### Edge Cases Checklist
- [ ] Decode a recording of clearly-spoken English → transcript shows the words
- [ ] Decode a silent recording → recognizer emits no-speech (correct, decoder isn't responsible for content)
- [ ] Decode a 5-min recording → completes within ~5s, no OOM
- [ ] Decode an existing share-audio (e.g. .mp3 podcast clip shared into carnet) → still works (MediaExtractor handles MP3)
- [ ] Decode a corrupted .m4a (truncated) → throws E_DECODE_FAIL with usable error message, no crash
- [ ] Force-stop carnet mid-decode → no orphaned cache file lurking forever (finally runs even on app death? NO, but OS reaps cache)
- [ ] Tap Transcribe twice in rapid succession → second tap blocked by transcribingRef (existing guard from PR #18)
- [ ] Cache directory full → FileSystem.writeAsStringAsync throws, surfaces as "Transcribe failed" in banner

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 202/202 tests pass (197 existing + 5 new facade).

### Plugin output verification
```bash
cd apps/mobile && ANDROID_HOME=/path/to/Android/Sdk bash scripts/verify-audio-decoder-prebuild.sh
```
EXPECT: all emitted files + MainApplication injection reported present.

### On-device
```bash
cd apps/mobile && ANDROID_HOME=/path/to/Android/Sdk bash scripts/build-release-apk.sh --install
```
EXPECT: APK builds, installs, launches. Record an audio note + tap Transcribe → real transcript appears.

### Manual smoke checklist
- [ ] Record a 10s "hello world testing this is carnet" → Transcribe → text matches roughly
- [ ] Record 1-minute speech → completes within ~10s, transcript is readable
- [ ] Toggle Auto-transcribe ON in Settings + record → saved screen spinner resolves silently, transcript appears on recent re-open
- [ ] Share an MP3 clip into carnet (e.g. from Pocket Casts) → Transcribe works
- [ ] Regression: audio playback (PR #22) still works
- [ ] Regression: persistent notification + widget still work
- [ ] Regression: text capture flows (Idea/Journal/Person) unaffected
- [ ] adb logcat shows no FATAL exceptions during decode

---

## Acceptance Criteria
- [ ] AudioDecoder native module emitted + registered via Expo plugin
- [ ] JS facade with isAvailable/decodeToWav matching captureNotification.ts shape
- [ ] transcribeOnDevice calls the decoder before the recognizer
- [ ] Verify script passes — all artifacts + MainApplication injection present
- [ ] 0 type errors; +5 new tests; 202/202 total
- [ ] **End-to-end on-device**: record audio → Transcribe → transcript appears in note

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MediaCodec buffer-handling bug crashes the app on decode | Medium first try | App crash during transcribe | Wrap entire decode in try/catch + finally cleanup of decoder + extractor; document log lines in PR body for debugging |
| Linear-interp downsample produces audible artifacts confusing the recognizer | Low | Lower transcription quality on noisy audio | Recognizer is tolerant of high-freq aliasing; if reports come in, switch to polyphase or use Android's built-in AudioFormat conversion |
| In-memory PCM buffer OOMs on very long recordings | Low | App crash on multi-hour clips | Document the ~30 min practical limit in NOT Building; switch to streaming write if a real user hits it |
| MediaCodec output is float PCM instead of 16-bit int on some devices | Low-medium | Garbled WAV → no-speech | Force PCM_16BIT via MediaFormat.KEY_PCM_ENCODING when configuring decoder; fall back to scaling if device ignores |
| Sample-rate-changed event mid-stream (rare for audio) | Very low | Mid-decode reformat needed | Handle INFO_OUTPUT_FORMAT_CHANGED in the dequeue loop (current code falls through to next loop iteration — wrong if format changes; add explicit re-read of getOutputFormat) — flag for first iteration |
| MainApplication injection regex misses on some future SDK shape | Medium long-term | Bridge unreachable, silent | Postcondition throw (PR #22's pattern) catches it loudly at prebuild |
| Concurrent transcribe taps collide on cache filenames (same Date.now() ms) | Very low | One overwrites the other | Existing transcribingRef guard prevents double-fire; if it ever races, add a counter to filename |
| Native module not autolinked in Hermes release mode | Low | Bridge undefined, transcribe falls back to passing raw m4a → no-speech (same as today) | facade.isAvailable() returns false, transcribeOnDevice falls back to old path; logged behavior, not a crash |

## Notes
- This PR is bigger than it looks because of the native Kotlin layer + Expo plugin scaffolding, but architecturally it's a thin transform layer: bytes in, bytes out, with a JS facade that's testable.
- After this lands, the entire transcription path is offline-capable. No OmniRoute proxy, no Whisper, no Gemini, no API key required.
- A natural v0.5 follow-up: have the recognizer stream results as the decode progresses (live-decode-and-recognize), shrinking the user-visible latency from ~5s to ~1s. Requires re-architecting the recognizer wrapper to accept chunks.
- The decoder module also unlocks a future audio-share-from-any-format pipeline (e.g. share an OGG voice note from Telegram, get a transcript). Out of scope here but worth noting as adjacent value.
