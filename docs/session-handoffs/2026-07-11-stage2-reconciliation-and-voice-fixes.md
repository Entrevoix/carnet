# Session handoff — 2026-07-11 (Stage 2 reconciliation; voice/audio bug chain fixed)

## State at handoff

Two distinct threads this session, both mostly wrapped up:

1. **Stage 2 backlog reconciliation** — discovered B0/B1/B3/B4/B5/B6/B7 were already shipped in a prior session (not reflected in `TODO.md`/`agent_roadmap.md`); merged the last open PR (#62, the design-doc set); ran the screen-decomposition roadmap item to completion (PRs #101–#103); attempted B2 (OCR fold-in) and found + fixed real bugs along the way (see below). **B2 itself is still not done** — see "Not done" below.
2. **A live bug chain from manual device testing** — the user reported a sequence of real bugs while testing on a physical Pixel, each investigated with the `/investigate` skill's root-cause discipline (logcat, native source, direct curl against the OmniRoute server) rather than guessed at. All fixed, committed to `main` directly (not squash-merged via PR — this was fast iterative device-testing, not a reviewed feature branch). **Verification of the last fix (a native crash) was in progress with a `qa-tester` teammate agent on the device when context was cleared** — see "In flight" below.

## What shipped this session (commits on `main`, in order)

Stage 2 / roadmap:
- **PR #62** — merged (Fable audit + Stage 2 design docs; required renaming `AUDIT.md`→`AUDIT-backend.md` to avoid colliding with the redesign's own `AUDIT.md`).
- **PR #101/#102/#103** — CaptureScreen/RecentDetailScreen/SettingsScreen business-logic extraction (`.agent_native/agent_roadmap.md` item #2). 10 new tested `lib/*.ts` modules total. Each independently code-reviewed, no CRITICAL/HIGH survived.
- `fbf7d28` — docs reconciling `TODO.md` + `agent_roadmap.md` with the above (they were stale — didn't reflect B-branch or screen-extraction work already on `main`).

Bug chain (all direct commits to `main`, listed oldest→newest):
- `268c560` — **B2 root cause found and fixed**: `ocr.ts` was hitting the wrong URL (`/ocr` not `/v1/ocr`), wrong body shape (bespoke `{image_b64}` instead of Mistral's `{document: {image_url}}`), missing `Authorization` header entirely, and parsing the wrong response shape (`{text}` instead of Mistral's real `{pages: [{markdown}]}`). All four confirmed via direct `curl` against the live OmniRoute server (SSH to `user@192.168.1.20`, container `omniroute`). Also required the user to connect a Mistral provider key via the OmniRoute dashboard (`dashboard/media-providers`) — `/v1/ocr` only supports Mistral for OCR, and none was configured server-side.
- `9ea90f5` — keyboard didn't dismiss on capture Send (only the "+" button did).
- `113dab9` — Whisper API key had no Settings UI at all, and its storage was plaintext `AsyncStorage` (a real violation of this repo's SecureStore-only hard constraint). Added proper fields + migrated storage.
- `68f96f4` — Audio-capture screen's "model missing" transcription error was flat, unactionable text; VoiceButton's dictation flow already had a real "Download model" + Play Store recovery UI for the identical underlying failure. Now both surfaces share it.
- `030ee7d` — two bugs in `VoiceButton.tsx`'s STT error handling: (1) untranslated raw error strings leaking to the user when the native `code` field was -1 (a documented library quirk), (2) code -1 wasn't failover-eligible, so a permanently-broken pinned recognizer (`com.google.android.tts`, not installed on the test device) was retried forever instead of falling through to the next candidate or the no-service UI.
- `3414313` — **a real crash**, found via `adb logcat -b crash`: `PromiseAlreadySettledException` in `expo-speech-recognition`'s own native Kotlin (`getSupportedLocales`), triggered when a recognizer fires `onError` twice for the same request (observed with `com.google.android.tts`, right after the user installed it). This is an upstream library bug with a documented-but-broken partial workaround already in their code. Fixed via `patch-package` (new `patches/expo-speech-recognition+3.1.3.patch`, `postinstall` hook added to root `package.json`).

## Not done / in flight — pick this up first

**B2 (fold OCR into chat vision) is still not implemented** — only the *bug fixes* that were blocking its evaluation shipped. The original B2 decision (fold vs. don't) still needs the on-device VLM-vs-`/ocr` quality comparison from `.claude/PRPs/plans/stage2-backend-and-capture.plan.md`, which hasn't run yet (it kept getting derailed by the OmniRoute-config and native-crash bugs above). Resume this once the device is in a clean state.

**The crash-fix verification never completed.** A `qa-tester` teammate agent (session name `b2-ocr-quality-test-2`) was mid-verification on the physical Pixel when context was cleared:
1. It had confirmed the *original* bug (infinite dead-end retry loop) was fixed.
2. It then hit the `PromiseAlreadySettledException` crash after installing "Speech Services by Google" through the app's own recovery UI.
3. The crash was root-caused and fixed (`3414313`, above) and a rebuilt APK was installed on the device.
4. **The agent was asked to re-verify (no more crash) and then continue the original happy-path check (does dictation actually work now) but no response had come back yet.**

Next session: reconnect to the device (`adb devices`), relaunch Carnet fresh (force-stop first), retry dictation, and confirm (a) no crash, (b) whether `com.google.android.tts` now actually works or still reports 0 locales (per the agent's last report, `com.google.android.googlequicksearchbox` — the only *other* registered recognizer on this device — also reports 0 locales, so this specific Pixel may have zero functioning on-device STT regardless of what's installed). If so, the newly-added Whisper Settings fields (`113dab9`) are the real fallback path for this device.

## Repo/session conventions confirmed this session (same as prior handoffs)

- Squash-merge via PR for reviewed feature work; direct commits to `main` are acceptable for fast iterative bug-fixing during live device testing (this session's bug chain), but keep each commit independently buildable/typecheck-clean — don't let unrelated changes leak across commit boundaries even when multiple fixes land in the same file.
- Every code-changing PR still got an independent `code-reviewer` pass before merge (PRs #101–#103).
- `qa-tester` subagents drive the physical device directly via adb — reuse the same agent (`SendMessage` to its name) across a chain of related follow-ups rather than spawning a fresh one each time; it keeps context (recognizer state, what's already installed, etc.) that's expensive to rediscover.
- **New this session:** `patch-package` is now part of the toolchain (`postinstall` hook). If a `node_modules` native-source patch is ever needed again: `npx patch-package <pkg> --exclude 'android/build/'` — without the exclude, Gradle's compiled build output (`.dex`, `.class`, transform caches) gets swept into the diff and produces a multi-megabyte, useless patch file. Learned this the hard way (first attempt was 4.8MB / 1989 files; the real fix was 2.9KB).

## Memory notes already saved (check these first, don't re-derive)

- `project_stage2_b_branches_status.md` — the full B0–B7 status reconciliation from earlier in this session, including the git-log verification method.
- `feedback_verify_git_log_before_roadmap.md` — the process lesson from that reconciliation (plan docs can lag actual merged work).

## Not started (mentioned, not yet worked on)

- The actual B2 fold-OCR-into-chat-vision decision (see "Not done" above).
- Composite action to dedupe `mobile-android`/`apk` CI toolchain setup — already resolved per `CLAUDE.md`, not a live item.
- Self-hosted Sentry crash reporting — mentioned in the 2026-07-09 handoff, still not started. Worth reconsidering given this session found a real native crash via manual `adb logcat` reading — Sentry (or even just a crash-log upload step) would have caught it automatically instead of requiring a human to notice the app died.
- Minimal ESLint — still just discussed, not scoped.
