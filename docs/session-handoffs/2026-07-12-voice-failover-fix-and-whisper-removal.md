# Session handoff — 2026-07-12 (STT failover UI fix; Whisper fallback removed)

## State at handoff

Direct continuation of `docs/session-handoffs/2026-07-11-stage2-reconciliation-and-voice-fixes.md`.
Picked up its top "pick this up first" item (the failover-chain-exhausted UI gap), fixed and
verified it on-device, then — on explicit user direction — removed the Whisper cloud-API STT
fallback entirely. Everything below is committed and pushed: `5090f33` on `main`
(`fbf7d28..5090f33`).

**Important state change from the prior handoff:** the prior handoff's "Next session" guidance
assumed Whisper (`113dab9`) as the pragmatic fallback for this device's broken on-device STT.
**Whisper no longer exists in this codebase.** The physical test Pixel currently has **zero
working speech-to-text path** until the code-9 investigation below is resolved. Read this before
assuming voice input works on-device for testing anything else.

## What shipped this session

1. **Failover-chain-exhausted UI fix** (`apps/mobile/src/voice/VoiceButton.tsx`) — the error
   handler fell through to a generic, non-actionable message when the failover chain emptied out
   *after* detection had already run once this app session (e.g. error code `-1`, the native
   catch-all for an absent pinned recognizer like `com.google.android.as`). Added a new branch
   ("4.5" in the numbered comment sequence) that shows the proper "no working speech service
   found" recovery sheet in that case too, matching the sheet already shown for the
   detection-never-ran case.
2. **Unified no-service messaging** — three near-duplicate "no speech service" strings (in
   `startRecognizerRef`, `triggerDetectionRef`, and the new branch 4.5) had drifted from each
   other in wording. Consolidated into one `NO_SERVICE_MESSAGE` module-level constant so future
   edits can't reintroduce the split.
3. **Verified on-device via `qa-tester`** on the physical Pixel (57211FDCG0023C) — confirmed PASS.
   Reproduced the exact failure chain (`com.google.android.tts` → code 9 → `com.google.android.as`
   → code -1/"No service found for package"); confirmed the proper actionable sheet now appears
   (Install Speech Services, Install Bixby, Use Whisper *[since removed, see below]*, Retry
   Detection, Copy diagnostics, Dismiss) instead of a dead-end message. Evidence (logcat +
   screenshots) saved under the qa-tester agent's scratchpad — not committed to the repo.
   - Session hit one blocker mid-verification: the device's screen was locked with a secure
     PIN, which `adb` cannot swipe past. Required the user to physically unlock it once; the
     agent resumed from the same build afterward (no rebuild needed).
4. **Removed the dangling doc reference** in two `VoiceButton.tsx` comments that pointed at
   `memory/android16-stt-soda-ambient-fix.md` — **this file has never existed** in the repo (no
   `memory/` or `learnings/` directory exists at the repo level; confirmed via full-repo search
   and `git log --all --grep`). The comments now just explain the Android 16 Soda
   `AMBIENT_ONESHOT` fix inline without pointing at a nonexistent doc.
5. **Confirmed the test device is Android 17 (SDK 37), not Android 16** as every existing code
   comment assumes (`adb shell getprop ro.build.version.release` → `17`). Researched whether
   Android 17 introduced a new `RecognitionService`/`SpeechRecognizer` bind restriction that could
   explain the code-9 mystery — **found no evidence of one**. Android 17's headline dictation
   feature ("Rambler") is a Gboard-keyboard-level Gemini dictation upgrade, a different surface
   from the classic `SpeechRecognizer` API this app calls; nothing in Android 17's official
   behavior-change docs mentions `RecognitionService` bind changes. The Android-16-vs-17 mismatch
   is real and worth keeping in mind, but is **not a confirmed explanation** for code 9 — don't
   present it as one without more evidence.
6. **Removed the Whisper cloud-API STT fallback entirely**, per explicit user decision (confirmed
   twice — once to proceed generally, once specifically to mean full removal rather than
   just de-emphasizing it as a suggested workaround). User explicitly accepted the consequence
   that this leaves the current test device with **no working STT path at all** until code-9 is
   separately fixed.
   - Deleted: `WHISPER_API_KEY`/`hasWhisperApiKey()`/`setWhisperApiKey()`/`whisperEndpoint`/
     `whisperApiKey` from `lib/settings.ts`; the Settings UI "Voice Input" Whisper endpoint/key
     form section from `SettingsScreen.tsx`; `startWhisper`/`finishWhisper`/`switchToWhisper`/
     `handlePickWhisper`/`whisperRecording` from `VoiceButton.tsx`; the `'whisper'` member of
     `SttEngine` and the `'use-whisper'` onboarding action from `sttOnboarding.ts`; matching
     fixture/test cleanup across 6 test files.
   - Also fixed two **pre-existing, independent** stale-copy bugs surfaced during the mapping
     pass: `omniroute.ts`'s `autoTranscribeOnSave` doc comment and `SettingsScreen.tsx`'s toggle
     helper text both mischaracterized the still-live, already-on-device auto-transcribe pipeline
     as "running through Whisper" — corrected to describe on-device transcription accurately.
   - Full diff: 18 files, 67 insertions / 424 deletions.
   - Verified: `tsc --noEmit` clean; full mobile vitest suite 867/867 passing; independent
     `code-reviewer` pass found **zero CRITICAL/HIGH**. Three non-blocking LOW notes left
     unaddressed (not required for merge, listed below).

## Not done / left for next session

1. **The code-9 (`service-not-allowed`) root cause is still unconfirmed.** Three original
   candidates from the 2026-07-11 handoff: (1) missing `<queries>` visibility — **ruled out** this
   session, confirmed the manifest already declares both explicit `<package>` entries and a broad
   `android.speech.RecognitionService` intent-action query; (2) a restricted-settings flag on the
   side-loaded (non-Play-Store) debug APK; (3) an Android 13+ (now confirmed: **Android 17**)
   recognizer-bind allowlist — searched for evidence, found none, remains unconfirmed either way.
2. **Voice input is now completely non-functional on the test Pixel** — no on-device recognizer
   works (per 2026-07-11 findings) and Whisper (the fallback) is gone. Next session should either
   resume the code-9 investigation with fresh eyes, or treat this as blocking further voice-flow
   device testing until resolved.
3. **Three LOW findings from the Whisper-removal code review, none blocking, all optional:**
   - `lib/karakeep.ts:462-464` — stale JSDoc still references the now-deleted Whisper upload path
     and its "needs XHR migration" follow-up TODO; both now dangle. Worth trimming.
   - Devices that previously saved a Whisper key retain an orphaned (harmless, encrypted,
     never-read-again) `carnet_whisper_api_key` in SecureStore forever — `purgeLegacySecretsOnce()`
     won't clear it. Not worth a purge-version bump per the reviewer, just noting for awareness.
   - `sttOnboarding.ts`'s `shouldPromptProactively` still checks `input.engine === 'ondevice'`
     even though `SttEngine` is now a single-member union — intentional per its own comment,
     harmless, flagged only for completeness.

## Repo/session conventions confirmed this session

- Two multi-file, non-trivial pieces of work (the Whisper-touchpoint mapping and the removal
  itself) were each delegated to a dedicated agent (`Explore` for mapping, `executor` with
  `model: opus` for the removal) rather than done inline — both proved worthwhile given the
  scope (18 files, logic tightly interleaved with shared on-device code in `VoiceButton.tsx`).
  An independent `code-reviewer` pass followed before commit, per this repo's standing review
  discipline.
- `qa-tester` device-verification can stall on a **secure lock screen** — `adb` can wake the
  display but cannot swipe past a PIN/pattern lock without the user physically unlocking it once.
  This is a new failure mode not previously documented (distinct from the Metro-tunnel-drops
  issue already in memory) — worth checking `dumpsys trust` early if a qa-tester agent goes idle
  without a report during device verification.
- When asked to "check the learning" or similar, a code comment pointing at a specific doc path
  is worth verifying actually exists before trusting it — this session found a comment referencing
  `memory/android16-stt-soda-ambient-fix.md`, a file that was apparently intended but never
  written, and no memory/learnings directory exists in this repo at all (the project's own
  auto-memory system lives outside the repo, under `~/.claude/projects/.../memory/`, which is a
  different thing entirely from what the code comment meant).
- Confirmed direct commits to `main` (vs. a reviewed PR branch) remain acceptable for this kind of
  session — continuation of an established bug-fix chain, verified end-to-end (typecheck, tests,
  on-device QA, code review) before commit, consistent with the 2026-07-11 handoff's stated
  convention.

## Not started (mentioned, not yet worked on)

- Self-hosted Sentry / crash reporting — mentioned in two prior handoffs now, still not started.
- Minimal ESLint — still just discussed, not scoped.
- B2 (fold OCR into chat vision) decision — still blocked on the on-device VLM-vs-`/ocr` quality
  comparison, itself now further blocked by voice-input being fully non-functional on the only
  available test device (not directly related to B2, but the same device is used for all
  on-device QA this session and last).
