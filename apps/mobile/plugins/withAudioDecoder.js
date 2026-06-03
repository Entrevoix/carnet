// TODO(plugin-cleanup): Kotlin templates are embedded as JS strings here
// for expedience. Future refactor: move to plugins/templates/audiodecoder/*.kt
// and render via __PACKAGE__ placeholder substitution. See the matching TODO
// in withCaptureNotification.js for rationale.
//
// AAC decoder bridge — Android-only native module that decodes any audio
// format Android's MediaExtractor supports (AAC, MP3, FLAC, Vorbis, Opus,
// AMR, WAV) into 16-bit mono PCM at 16 kHz, wrapped in a RIFF/WAVE header.
//
// Why this exists: expo-speech-recognition's file-mode audioSource reads
// the input as raw PCM. Our audio captures (PR #16) are AAC-in-MP4 which
// the recognizer can't decode — it interprets encoded bytes as noise
// samples and emits no-speech. This module sits between
// audioTranscribeOnDevice.ts's cache write and the recognizer's start,
// translating any format we have into the only one the recognizer can
// understand.
//
// No new permissions required — MediaCodec is unprivileged.
//
// Two stages:
//   1. withMainApplication — inject the package registration into
//      MainApplication.kt. Same 4-pattern regex + applyAdd/localAdd
//      discriminator from PR #22's withCaptureNotification fix. Throws on
//      injection failure to prevent silent bridge-unreachable bugs (the
//      exact failure mode that ate 4 hours of debug time in PR #22).
//   2. withDangerousMod — write AudioDecoderModule.kt + AudioDecoderPackage.kt
//      into android/app/src/main/java/{packagePath}/audiodecoder/.

const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');

function audioDecoderModuleKt(packageName) {
  return `package ${packageName}.audiodecoder

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes any audio format Android's MediaExtractor supports (AAC, MP3,
 * FLAC, Vorbis, Opus, AMR, WAV) into 16-bit mono PCM at 16 kHz and writes
 * a standard RIFF/WAVE file.
 *
 * Target format is fixed because the only consumer is
 * expo-speech-recognition, which expects exactly that shape.
 *
 * MEMORY: decoded PCM is accumulated fully in memory at the SOURCE
 * rate/channels before mixdown + resample, then copied once by
 * toByteArray(). Peak ≈ 2 × durationSec × srcRate × srcChannels × 2 bytes
 * (e.g. ~5 min of 44.1 kHz stereo ≈ 106 MB transient). Inputs longer than
 * MAX_INPUT_DURATION_US are rejected with E_INPUT_TOO_LONG to bound this;
 * a streaming resampler would remove the cap (deferred known limit).
 */
class AudioDecoderModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "AudioDecoder"

  companion object {
    private const val TARGET_SAMPLE_RATE = 16000
    private const val TARGET_CHANNELS = 1
    private const val TARGET_BITS = 16
    private const val DEQUEUE_TIMEOUT_US = 10_000L
    // Overall wall-clock budget for the decode loop. The per-call dequeue
    // timeout is NOT a total bound — without this, a codec that never
    // signals output EOS (malformed stream / OEM quirk) busy-spins forever.
    private const val DECODE_BUDGET_NS = 60_000_000_000L
    // In-memory PCM guard (see class doc). 1_200_000_000 µs = 20 min — well
    // past any voice note yet bounds pathological multi-hour shares.
    private const val MAX_INPUT_DURATION_US = 1_200_000_000L
  }

  @ReactMethod
  fun decodeToWav(inputUri: String, outputUri: String, promise: Promise) {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    try {
      val inUri = Uri.parse(inputUri)
      if (inUri.scheme != null && inUri.scheme != "file") {
        return promise.reject(
          "E_BAD_INPUT",
          "Input must be a file:// path (got scheme '\${inUri.scheme}'); content:// is not supported."
        )
      }
      val inputPath = inUri.path
        ?: return promise.reject("E_BAD_INPUT", "Input URI has no path: \$inputUri")
      extractor.setDataSource(inputPath)

      // Find the audio track. Some containers (mp4) interleave video too.
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
        return promise.reject("E_NO_AUDIO_TRACK", "No audio track found in input")
      }
      extractor.selectTrack(trackIdx)

      // Reject over-long inputs up front to bound the in-memory PCM
      // accumulator (see class doc / MAX_INPUT_DURATION_US).
      if (trackFormat.containsKey(MediaFormat.KEY_DURATION)) {
        val durationUs = trackFormat.getLong(MediaFormat.KEY_DURATION)
        if (durationUs > MAX_INPUT_DURATION_US) {
          return promise.reject(
            "E_INPUT_TOO_LONG",
            "Audio is \${durationUs / 60_000_000} min — decoder caps at " +
              "\${MAX_INPUT_DURATION_US / 60_000_000} min (in-memory PCM limit)."
          )
        }
      }

      // Seed rate/channels from the input track, but the codec OUTPUT format
      // (read on INFO_OUTPUT_FORMAT_CHANGED in the loop) is authoritative —
      // HE-AAC/AAC+ (SBR/PS) lie about rate/channels on the container, which
      // would otherwise mix/resample with wrong divisors → wrong-pitch garbage.
      var sampleRate = if (trackFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE))
        trackFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) else TARGET_SAMPLE_RATE
      var channels = if (trackFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT))
        trackFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else TARGET_CHANNELS
      val mime = trackFormat.getString(MediaFormat.KEY_MIME)!!

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(trackFormat, null, null, 0)
      decoder.start()

      // Decode loop. Accumulate output PCM into a growable buffer.
      val pcmOut = ByteArrayOutputStream()
      val bufferInfo = MediaCodec.BufferInfo()
      var inputEos = false
      var outputEos = false
      val timeoutUs = DEQUEUE_TIMEOUT_US
      val deadlineNs = System.nanoTime() + DECODE_BUDGET_NS

      while (!outputEos) {
        // Wall-clock guard: the per-call dequeue timeout is not a total
        // bound, so a codec that never signals output EOS can't hang here.
        if (System.nanoTime() > deadlineNs) {
          return promise.reject(
            "E_DECODE_TIMEOUT",
            "Decode exceeded \${DECODE_BUDGET_NS / 1_000_000_000}s budget"
          )
        }
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
        if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          // Authoritative decoded format — THE fix for HE-AAC/AAC+ where the
          // container header lies about rate/channels. Read it from here.
          val outFormat = decoder.outputFormat
          if (outFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
            sampleRate = outFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          }
          if (outFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
            channels = outFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          }
        } else if (outIdx >= 0) {
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
        // INFO_TRY_AGAIN_LATER falls through — loop continues until output
        // EOS or the wall-clock deadline trips.
      }

      val rawPcm = pcmOut.toByteArray()
      val mono = if (channels == TARGET_CHANNELS) rawPcm else mixToMono(rawPcm, channels)
      val resampled =
        if (sampleRate == TARGET_SAMPLE_RATE) mono
        else resampleLinear(mono, sampleRate, TARGET_SAMPLE_RATE)
      val wav = wrapInWavHeader(resampled, TARGET_SAMPLE_RATE, TARGET_CHANNELS, TARGET_BITS)

      val outPath = Uri.parse(outputUri).path
        ?: return promise.reject("E_BAD_OUTPUT", "Output URI has no path: \$outputUri")
      File(outPath).parentFile?.mkdirs()
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

  /** Average all channels into one. 16-bit little-endian samples. */
  private fun mixToMono(pcm: ByteArray, channels: Int): ByteArray {
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

  /** Linear-interpolation resampler — handles both up- and down-sampling
   * (sub-16 kHz sources like 8 kHz AMR give ratio < 1 and upsample).
   * Quality is fine for 16 kHz STT — aliasing artifacts in the inaudible
   * high-freq range are below the recognizer's sensitivity envelope.
   * Polyphase would add ~200 LOC for negligible accuracy gain. */
  private fun resampleLinear(
    pcm: ByteArray,
    srcRate: Int,
    dstRate: Int,
  ): ByteArray {
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

  /** 44-byte RIFF/WAVE header for 16-bit linear PCM. Little-endian. */
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
`;
}

function audioDecoderPackageKt(packageName) {
  return `package ${packageName}.audiodecoder

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/** ReactPackage registration for the AudioDecoder native module. */
class AudioDecoderPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AudioDecoderModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
`;
}

module.exports = function withAudioDecoder(config) {
  const packageName = config.android?.package;

  // Stage 1 — MainApplication.kt package registration.
  // Same 4-pattern regex + applyAdd/localAdd discriminator as
  // withCaptureNotification.js (lesson from PR #22).
  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const importLine = `import ${packageName}.audiodecoder.AudioDecoderPackage`;

    if (!contents.includes(importLine)) {
      contents = contents.replace(
        /(^import [^\n]+\n)(?![\s\S]*^import [^\n]+\n)/m,
        `$1${importLine}\n`,
      );
    }

    if (!contents.includes('AudioDecoderPackage()')) {
      // Two call shapes — they differ by which `this` is in scope inside
      // the getPackages() body:
      //   - applyAdd: inside `.apply { ... }` on the package list, `this`
      //     IS the (mutable) list, so the call is bare `add(...)`. Using
      //     `packages.add(...)` here fails with `Unresolved reference 'packages'`.
      //   - localAdd: legacy `val packages = PackageList(this).packages`
      //     shape has a named local; the call needs the `packages.` prefix.
      const applyAdd = 'add(AudioDecoderPackage())';
      const localAdd = 'packages.add(AudioDecoderPackage())';

      // Pattern 1 — Expo SDK 54+ template with example comment.
      let inserted = contents.replace(
        /(\/\/ add\(MyReactNativePackage\(\)\)\n)/,
        `$1              ${applyAdd}\n`,
      );
      // Pattern 2 — SDK 54 shape sans example comment.
      if (inserted === contents) {
        inserted = contents.replace(
          /(\.apply\s*\{\n)/,
          `$1              ${applyAdd}\n`,
        );
      }
      // Pattern 3 — legacy pre-54 shape: `val packages = PackageList(this).packages`.
      if (inserted === contents) {
        inserted = contents.replace(
          /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
          `$1            ${localAdd}\n`,
        );
      }
      // Pattern 4 — alternate legacy shape: explicit override fun with body.
      if (inserted === contents) {
        inserted = contents.replace(
          /(override fun getPackages\(\):[^{]*\{[^\n]*\n\s*val packages[^\n]*\n)/,
          `$1            ${localAdd}\n`,
        );
      }
      contents = inserted;
    }

    // Postcondition: silent regex misses produce a manifest+kotlin tree
    // that LOOKS healthy but the RN bridge module is unreachable. Fail
    // prebuild loudly with a pointer to what needs updating. Same lesson
    // as withCaptureNotification's PR #22 fix.
    if (!contents.includes('AudioDecoderPackage()')) {
      throw new Error(
        '[withAudioDecoder] Failed to inject `add(AudioDecoderPackage())` ' +
          'into MainApplication.kt. Expected one of: ' +
          '(a) `// add(MyReactNativePackage())` example comment in an .apply block (SDK 54), ' +
          '(b) `.apply {` block opener (SDK 54 without the example comment), ' +
          '(c) `val packages = PackageList(this).packages` line (legacy SDK), ' +
          '(d) `override fun getPackages()` followed by `val packages` (legacy SDK). ' +
          'None matched — update the plugin for this Expo SDK MainApplication shape.',
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  // Stage 2 — emit Kotlin sources.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const packagePath = packageName.replace(/\./g, '/');
      const javaDir = path.join(
        root,
        'app',
        'src',
        'main',
        'java',
        packagePath,
        'audiodecoder',
      );
      fs.mkdirSync(javaDir, { recursive: true });

      fs.writeFileSync(
        path.join(javaDir, 'AudioDecoderModule.kt'),
        audioDecoderModuleKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'AudioDecoderPackage.kt'),
        audioDecoderPackageKt(packageName),
        'utf8',
      );

      return cfg;
    },
  ]);

  return config;
};
