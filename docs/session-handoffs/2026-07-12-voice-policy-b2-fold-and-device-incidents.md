# Session handoff — 2026-07-12 (voice error-policy + silence auto-stop; B2 OCR fold shipped; two device incidents)

## State at handoff

Continuation of `2026-07-12-voice-failover-fix-and-whisper-removal.md`. Very large session:
solved the code-9 mystery for real, fixed a self-inflicted restart race, extracted the STT
error policy into a tested module, added silence auto-stop + a mic-revoked recovery sheet,
ran the B2 quality gate and shipped the OCR fold-in, and diagnosed two device-state incidents
along the way. **Stage 2 (B0–B7) is now fully shipped.**

Commits this session, oldest first:
- `3309ef6` (pushed, CI green) — error+end double-restart race fix + corrected code-9 comments.
- `063ae09` (pushed, CI green) — code-9 revival on fresh dictation attempts (`reviveUserRecoverablePkgs`).
- `01f4391` (**unpushed**) — sttErrorPolicy extraction (46 tests), mic-revoked recovery sheet
  (expo-intent-launcher dep, loaded via `requireOptionalNativeModule` — see gotcha below),
  silence auto-stop (2 consecutive quiet windows ≈ 18–20s → stop + commit; 3-min cap unchanged).
- `1ec18e0` (**unpushed**) — B2: retire `lib/ocr.ts`/`/v1/ocr`, add `ocrCardViaVision` in
  `lib/omniroute.ts` (visionModel, temperature 0, `stream:false`), CardScannerModal switched.

**`mobile-android` CI has NOT yet built the expo-intent-launcher native dep** — that happens
on the next push. Watch that job once these land.

## Root causes established this session (all verified on-device)

1. **Original code 9 (`service-not-allowed`)**: Speech Services (`com.google.android.tts`)
   itself had RECORD_AUDIO revoked (Android unused-app auto-revoke). The proxied AppOps mic
   check covers caller AND recognizer; the recognizer-side denial surfaces as code 9. Fix:
   `pm grant`. The old "Android 13+ bind restriction" theory is disproven and scrubbed from
   comments.
2. **"No working speech service" with a WORKING recognizer**: after a silence timeout, the
   code-7 error branch reset `errorHandlingRef` synchronously, letting the `end` listener
   schedule a second overlapping restart; the sessions killed each other (code 11 storm)
   until failover blacklisted the good recognizer. Invariant now encoded in sttErrorPolicy:
   only the native `start` event (or explicit user action) resets the latch.
3. **Stale mic-revoked sheet after the user fixed the permission**: code-9 pkgs stayed in the
   session blacklist, so "enable Microphone, then try again" could never succeed.
   `reviveUserRecoverablePkgs` un-blacklists code-9 pkgs at every fresh session start.

## B2 (OCR fold) — gate evidence and outcome

Gate ran server-side against the live OmniRoute (SSH `user@192.168.1.20`, port 20128):
3 real card photos through `/v1/ocr` (Mistral) vs `gemini-2.5-flash` and `gpt-4o-mini`
chat-vision with a fixed transcription prompt. Gemini matched Mistral field-for-field on
standard cards and captured stylized text Mistral missed; 4o-mini at parity on flat text.
Latency ~2–4s vs ~1–1.6s (acceptable behind the existing spinner). PASS → fold shipped.
Raw outputs: `~/b2-ocr-test/results/` on the server (API key used for the test was deleted).
End-to-end on-device verification: real card scanned → `ocrCardViaVision` (1.9s) → person
enrichment (2.0s) → correct contact note ("Zachary Hoyt"). The OmniRoute Mistral provider
key is now unused by carnet (only `/v1/ocr` needed it) — candidate for dashboard cleanup.

## Device incidents (know these before trusting the test Pixel)

1. **The app was reinstalled 2026-07-11 17:36 EDT** (matches `lastUpdateTime`), wiping ALL
   app data: settings blob, note index, SecureStore keys. This is why "OmniRoute not
   configured" appeared during B2 verification. OmniRoute URL/key/models were re-entered via
   the Settings UI this session (URL `http://192.168.1.20:20128`, models gpt-4o-mini) and
   verified persisted (`carnet:settings:v2` in RKStorage).
2. **`captureFolderPath` is still blank** — notes are landing in app-private storage
   (`files/carnet/Ideas/fun-run.md`, `files/carnet/People/Zachary-Hoyt.md`), NOT in any
   Syncthing-watched folder; zero `.md` files exist anywhere on /sdcard. The user needs to
   re-point the vault folder in Settings, then move those two notes in (adb can do it).
   NB: the 2026-07-11 session's "contact note file search returned no results" observation
   is explained by the same wipe.
3. **Carnet was found disabled** (`enabled=3`, "disabled by user" — likely an accidental
   launcher "Pause app") mid-session; fixed via `pm enable --user 0 com.ventoux.carnet`.
   If `am start` ever says "Activity class does not exist" while the package lists fine,
   check this first.

## Gotchas worth keeping

- **Adding an Expo native dep mid-iteration red-screens every installed client at bundle
  eval** (`requireNativeModule` runs at import). `try/catch require()` is NOT enough in dev —
  Metro reports the factory throw as fatal before the catch. Use
  `requireOptionalNativeModule('ExpoIntentLauncher')` (from `expo`) and a graceful fallback.
  The App-info deep link on the mic-revoked sheet therefore falls back to
  `Linking.openSettings()` until the next APK build autolinks the module.
- **OmniRoute streams SSE by default** — every direct `/v1/chat/completions` body must set
  `stream: false` (documented in `omniroute.ts` ~line 255; `ocrCardViaVision` complies).
- The user's other Ventoux app (`com.ventouxlabs.relais.izzy`) shares the test device; check
  `mCurrentFocus` before injecting taps — one shutter tap this session landed in relais.

## Not done / next

- Push `01f4391` + `1ec18e0`; watch `mobile-android` (first CI build with expo-intent-launcher).
- Vault folder re-configuration + moving the two stranded notes (blocked on user's folder path).
- Voice follow-ups: extract VoiceButton's listener wiring (file is ~1500 lines; the
  error/end/result interplay — auto-stop teardown, error-before-end ordering — has no
  automated coverage); reviewer LOWs (useRef closure idiom, stale karakeep.ts JSDoc).
- Backlog: self-hosted Sentry (third handoff mentioning it), minimal ESLint, desktop fate.
