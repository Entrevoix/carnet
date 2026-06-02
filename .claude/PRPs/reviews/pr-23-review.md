# PR Review: #23 — feat: AAC decoder bridge for on-device STT

**Reviewed**: 2026-06-01
**Author**: bearyjd
**Branch**: feat/aac-decoder-bridge → main
**Decision**: REQUEST CHANGES (2 HIGH correctness items in the native decode loop)

## Summary
The JS/TS integration, config-plugin structure, WAV header, and restored test suite are solid (type-clean, 213/213 green, prebuild verify healthy). Two HIGH-confidence correctness gaps in the emitted Kotlin decoder should be fixed before merge: sample rate/channels are read from the container's input track instead of the codec's output format (garbage transcripts for HE-AAC/AAC+ shared audio), and the decode loop has no wall-clock timeout (a wedged codec hangs the capture forever — the JS 90s timeout only wraps the recognizer, not the decode). Plus the actual decode-vs-fallback wiring this PR introduces ships untested.

## Findings

### CRITICAL
None.

### HIGH
- **H1 — Decoder reads sample rate / channel count from the INPUT track, not the codec OUTPUT format.** `withAudioDecoder.js` (emitted Kotlin ~L90-91, 124-151). MediaCodec's decoded output format is authoritative and can differ from the container's declared format — notably HE-AAC / AAC+ (SBR/PS), where the container often declares half the true sample rate and mono-declared-but-stereo-decoded. Mixdown/resample then use wrong divisors → wrong pitch/speed → recognizer reads garbage. This is the module's *primary* input (shared podcast/m4a). The loop comment explicitly no-ops on `INFO_OUTPUT_FORMAT_CHANGED`. **Fix:** capture the output format (read `KEY_SAMPLE_RATE`/`KEY_CHANNEL_COUNT` from `decoder.getOutputFormat()` after the first `INFO_OUTPUT_FORMAT_CHANGED` / first real output buffer) and use those for mixdown + resample. Also fixes M2 (absent-key throw).
- **H2 — Decode loop can hang indefinitely; no wall-clock budget.** `withAudioDecoder.js` (~L103-144). `while (!outputEos)` exits only on output EOS; the 10ms `timeoutUs` is per-call. A codec that never propagates EOS (malformed stream / OEM driver quirk) → tight busy-spin pegging a CPU core, permanent hang on that capture. The JS-side 90s timeout (`audioTranscribeOnDevice.ts:35`) wraps only `runRecognizer`, which starts *after* `decodeToWav` resolves — it does not bound a hung decode. **Fix:** add a `System.nanoTime()` wall-clock budget; on exceed, `promise.reject("E_DECODE_TIMEOUT", …)` and break.

### MEDIUM
- **M1 — In-memory PCM ceiling understated; OOM risk.** Accumulator holds *source-rate* PCM (pre-mix/downsample); docstring's "~5 min ≈ 9.6 MB / ~30 min comfortable" is the final-size figure, not the accumulator. Real peak for 30 min stereo ≈ 317MB accumulator + ~317MB `toByteArray()` copy → past OOM-kill on most devices. **Fix:** incremental resample as chunks arrive, or a hard `E_INPUT_TOO_LONG` duration cap; at minimum correct the docstring.
- **M2 — `getInteger(KEY_SAMPLE_RATE/CHANNEL_COUNT)` can throw if the key is absent** on the input track → swallowed as generic `E_DECODE_FAIL`. Subsumed by H1's output-format read.
- **M3 — Output file opened without ensuring its parent dir exists** (`FileOutputStream(outPath)`). Happy path is fine (cacheDirectory exists) but it's an unguarded assumption surfaced as generic failure. **Fix:** `File(outPath).parentFile?.mkdirs()`.
- **M4 — No `file://` scheme validation (native + facade).** `Uri.parse(inputUri).path` silently mishandles `content://`. Contract-honored today (only cache `file://` paths passed), but a latent regression given the app's heavy SAF/`content://` usage. **Fix:** assert scheme and reject clearly, or use `MediaExtractor.setDataSource(Context, Uri)`.
- **M5 — `mixToMono` integer-truncates (minor DC bias) and drops a trailing partial frame.** `totalFrames = remaining()/channels` discards a non-frame-aligned tail at EOS. Overflow verified NOT a concern. Low practical impact for STT.
- **M6 — verify script uses `set -e`, not `set -euo pipefail`** (`verify-audio-decoder-prebuild.sh:20`). A misspelled var silently expands empty and masks a real failure — undercuts a script whose whole job is to be a loud gate.
- **M7 — Prebuild stdout silenced** (`:33`, `>/dev/null`). Plugin throws survive on stderr, but a partial-tree diagnostic is invisible, leaving only `✗ MISSING` with no cause. **Fix:** redirect to a log and dump on failure.
- **M8 — Degenerate temp-file extension for trailing-dot/dotfile names** (`audioTranscribeOnDevice.ts:47-49`). `"trailing."` → `.`; `".hidden"` → `.hidden`. Cosmetic on the decode path (MediaExtractor sniffs by content), but matters on the fallback path. **Fix:** require `lastIndexOf(".") > 0 && slice.length > 1`, else default `.m4a`.
- **M9 — The decode-vs-fallback wiring is untested.** The `isAvailable()` branch (raw vs WAV to the recognizer) + the `finally` cleanup of both temp files — i.e. the actual behavior change in this PR — has zero coverage. (The 5 facade tests are genuine and meaningful, but they cover the facade, not the wiring.) **Fix:** add a `transcribeOnDevice` test mocking `./audioDecoder` + `expo-file-system/legacy` asserting (a) available → `decodeToWav(raw,wav)` called, recognizer gets `wav`; (b) unavailable → recognizer gets `raw`; (c) `deleteAsync` for both paths on success and throw.

### LOW
- `downsampleLinear` handles upsampling (<16kHz, e.g. 8kHz AMR) correctly — verified boundary-safe — but the name/docstring imply down-only. Rename `resampleLinear`.
- Magic numbers (`16000`/`1`/`16`/`10_000L`) — extract a `companion object`; the 16kHz/mono/16-bit triple is the load-bearing recognizer contract.
- Broad `catch (e: Exception)` — acceptable at the RN bridge boundary; `e` is passed to `promise.reject` so RN surfaces it.
- Fallback comment overstates "PCM/WAV inputs would still work" — a WAV's 44-byte header is read as a brief noise blip. Soften wording.
- verify script `PKG_PATH="us/beary/carnet"` hardcoded — false-red if `android.package` changes. Derive from app.json.
- verify script `find -name A -o -name B` precedence is brittle — group with `\( … \)`.
- Import-insertion regex is order-coupled across sibling plugins (`withCaptureNotification.js` uses the identical regex). Currently correct + idempotent via the `includes()` guard. Document the assumption or anchor on the stable `package` line.

### Open Questions (LOW confidence — need device/runtime)
- Lost-final-transcript if the recognizer emits `end` before the final `result` (`audioTranscribeOnDevice.ts:147-164`). The author already guards the converse (keep latest non-empty). Needs runtime confirmation of Android Soda event ordering.
- Pattern-2 (`.apply {`) `add()` injection could match an unintended earlier `.apply {` in a future MainApplication shape. Doesn't trigger against the current template (Pattern 1 matches).

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Lint | Skipped (no lint script in @carnet/mobile) |
| Tests (`vitest run`) | Pass — 213/213 |
| Prebuild verify (`verify-audio-decoder-prebuild.sh`) | Pass — Kotlin + import + add() present |
| Build (release APK) | Not re-run this review (built clean per impl report); native decoder correctness (H1/H2/M-native) is unverified without on-device runtime QA |

## Files Reviewed
- `apps/mobile/plugins/withAudioDecoder.js` — Added (native plugin + emitted Kotlin)
- `apps/mobile/src/lib/audioDecoder.ts` — Added (facade)
- `apps/mobile/src/lib/audioDecoder.test.ts` — Added (5 facade tests)
- `apps/mobile/scripts/verify-audio-decoder-prebuild.sh` — Added
- `apps/mobile/src/lib/audioTranscribeOnDevice.ts` — Modified (decoder wiring)
- `apps/mobile/app.json` — Modified (plugin registration)
- `apps/mobile/src/lib/omniroute.test.ts` — Modified (reviewed & hardened in a prior pass; not re-reviewed)
- `.claude/PRPs/{plans,reports}/**` — Added (docs)
