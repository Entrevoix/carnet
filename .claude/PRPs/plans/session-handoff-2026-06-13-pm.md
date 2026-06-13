# Session handoff — 2026-06-13 (PM), bridges a /clear

> Long, productive session. Many PRs merged + two new features built. This is the "where we are"
> doc. `main` is clean; the only in-flight item is PR #51 (Karakeep) finishing CI → merge.

## Shipped this session (all merged to `main` unless noted)
- **#45** — issue **#43** WYSIWYG large-image **inject-then-swap** + save hardening (ack-gated, `isSuspiciousBlanking`). **On-device smoke PASSED** (Pixel 9): the big baseball photo that wouldn't preview under #42's 8 MB cap now renders inline; both images preview (no blank editor); Save round-trips to canonical `../Photos/` links, no blob.
- **#46** — backlog audit: the scoped trio (editor-web, share types, package rename) was found **already shipped**.
- **#47** — reconciled all PRP plan docs (archived 11 shipped plans to `completed/`; active dir trimmed).
- **#48** — recorded the #43 on-device smoke PASS.
- **#49** — closed out package-rename (verified) + share-types (visibility confirmed) on-device.
- **#50** — **STT onboarding**: the cryptic `code 12` / "no service found" dead-end now offers an in-app
  **"Download voice model"** button via `ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload`.
  New `src/voice/sttReadiness.ts` (pure `mapReadiness` + `checkSttReadiness` + `triggerVoiceModelDownload`,
  12 tests); additive change to VoiceButton's `lang-unavailable` sheet; friendlier `audioTranscribeOnDevice`
  error. **No TTS work** (carnet has zero text-to-speech). vitest 500/500.
- **#51** — **Karakeep export v1** (per-note "Send to Karakeep" → text bookmark + tags; `karakeepId`
  idempotency in frontmatter; Settings "Karakeep" section). New `src/lib/karakeep.ts` (mirrors omniroute
  hardening; 15 tests). vitest 515/515. **PENDING: CI → merge** (auto-merge is disabled on this repo;
  merge manually once green). End-to-end against a live Karakeep instance not yet run.

## Important corrections made this session (don't re-walk)
- **The Pixel devices are STOCK Google Android 16 (`comet-user`, release-keys), NOT GrapheneOS/Vanadium.**
  Several older handoff docs mislabel them. WebView is stock Chrome. (The #43 render passed on stock WebView.)
- **`app.grapheneos.speechservices` is a TTS engine** (declares only `TTS_SERVICE`/`CHECK_TTS_DATA`), NOT a
  speech recognizer — a red herring (already in `pixel-stt-device-recognizer-health` memory). There is NO
  GrapheneOS-native recognizer to "switch to."
- **STT recognizer-health hardening was ALREADY BUILT** (code-11 retry, 0-installed-locale demotion, Whisper
  fallback) — the memory's "not yet built" was stale; corrected. The real STT gap was onboarding (→ #50).
- `enabled=0` in `dumpsys package` = `COMPONENT_ENABLED_STATE_DEFAULT` (enabled), not disabled.

## Open / pending
- **#51 Karakeep** — finish CI + merge. Then: end-to-end export against a live Karakeep instance (needs an
  instance URL + API key). Research decision doc open Qs: `PATCH /bookmarks/{id}` update semantics for true
  re-export; asset multipart field name (only matters for v2 attachment upload).
- **#50 STT onboarding** — on-device download-flow smoke pending a device in the **needs-model** state (both
  attached Pixels currently HAVE the en model, so the "Download voice model" button won't surface to test).
- **Karakeep v2:** asset/attachment upload, bulk export, lists, multi-locale, progress UI.
- **STT onboarding v2:** proactive first-run readiness check (download before the user hits the error);
  Settings "Check voice setup" action.
- **Share-save end-to-end:** user did the gesture ("done"); visibility CONFIRMED earlier (Carnet shows in the
  real Android chooser for `*/*`). The synthetic adb share can't be driven (shell `content://` grant unreadable
  by carnet) — only a real human share completes it.

## Device / on-device QA facts (verified this session)
- **Pixel 9 Pro Fold** `4A111FDKD0000C` (comet, STOCK Android 16) — has OmniRoute configured + the disposable
  **"Jack's Baseball Team"** note (2 images: baseball + yard photo). Use for editor/STT QA.
- **Pixel 10 Pro Fold** `57211FDCG0023C` (rango) — carnet vault is **EMPTY** (no Syncthing) and **OmniRoute is
  NOT configured** (Send surfaces "OmniRoute URL not configured" — incidentally re-verifies #29). File/audio
  **share** branches don't need OmniRoute (deterministic stub), so share-save works there.
- **Both foldables drop off USB mid-session** → `adb kill-server && adb start-server` (resets both) or re-seat
  cable + accept "Allow USB debugging". They re-lock; **adb can't enter the PIN — the user must unlock.**
- **adb screenshots ARE device pixels** — read tap coords directly, do NOT multiply by any display-scale factor
  (an earlier ×1.18 assumption made taps miss). **Native screens are uiautomator-dumpable** for exact bounds;
  the **editor WebView body is NOT** (OOM) → use screenshots there.
- **Pixel 10 inner-display screenshots exceed 2000 px** → the image API rejects them; downscale first
  (`python3 -c "from PIL import Image; ..."`).
- **Build + install:** `cd apps/mobile && ANDROID_SERIAL=<serial> ANDROID_HOME=/home/user/Android/Sdk npm run android:release` (~1.5 min, native cached; in-place `-r` preserves the vault). #50/#51 are RN-JS only → no editor:build needed.
- Foreground stealers to `am force-stop`: `cc.grepon.portage.{send,recv}`, `com.google.android.apps.kids.familylink`, Molly/Signal, AntennaPod. `cmd notification set_dnd none` + `svc power stayon true` help.

## Memory pointers
[[active-backlog-2026-06-13]], [[backlog-prp-plans]], [[pixel-stt-device-recognizer-health]],
[[build-env-no-google-maven-fetch]], [[pixel-fold-on-device-qa-quirks]].
