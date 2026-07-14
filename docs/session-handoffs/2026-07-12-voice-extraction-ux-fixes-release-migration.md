# Session handoff — 2026-07-12/13 (voice listener extraction; dark-cursor + Karakeep UX fixes; device moved to release build)

## State at handoff

Continuation of `2026-07-12-voice-policy-b2-fold-and-device-incidents.md`. Three commits,
all pushed, CI green through `8cf9d01`. The test Pixel now runs a **release-signed build**
with **freshly wiped data** (deliberate — see "Device migration" below).

Commits this session, oldest first:
- `3f3812e` — voice/dictationSession extraction: VoiceButton's `result`/`end` listener
  state machine (transcript accumulator, silence auto-stop, error-before-end latch,
  external-flush teardown) pulled into a pure decide-only module with 28 tests, same
  pattern as `sttErrorPolicy.ts`. The three transcript refs collapsed into one immutable
  `TranscriptAccumulator` ref. This closes the last unblocked item from the previous
  handoff. Also trimmed the stale Whisper JSDoc in `lib/karakeep.ts` (leftover LOW).
- `202d8f8` — dark-mode cursor visibility: new `caretProps()` in `lib/theme.ts`
  (caret/handles = `colors.primary`, selection = primary @ 40%) spread onto all 21 native
  TextInputs; rule documented in DESIGN.md. Android's default caret was near-invisible on
  the dark ink surface.
- `8cf9d01` — Karakeep "Unsupported asset type" handled gracefully: verified against
  karakeep source (`packages/api/utils/upload.ts` returns 400 `{"error":"Unsupported
  asset type"}` for MIME types outside ~images+PDF). `pushNoteAttachments` now treats
  that specific 400 as a per-file skip (vault-only, loop continues, deliberately NOT
  recorded so a server upgrade retries it); real failures still stop the loop. Skips
  surface on the success snackbar ("…is a file type Karakeep doesn't accept — kept in
  the vault only"), not as errors. 7 new tests.

Each commit had an independent code-reviewer pass before landing (APPROVE ×2, APPROVE
WITH NITS ×1 with both nits applied). Suite now **952 tests / 60 files**; tsc clean.

## Device migration (debug → release) — changes every future device workflow

The debug build was uninstalled (full data wipe, user-approved "start over") and replaced
with a release-signed 0.2.0 APK built locally from `8cf9d01`
(`apps/mobile/scripts/build-release-apk.sh`, shared keystore). Verified installed,
non-debuggable, and resumed behind the keyguard. Consequences:

- **No `run-as` anymore** — RKStorage surgery / app-private file inspection require a
  debug reinstall first (which itself requires uninstall = another wipe). Recipes are
  preserved in `.omc/skills/rkstorage-asyncstorage-surgery-workflow.md` (local, untracked).
- **No Metro / `adb reverse`** — JS is bundled; the red-screen ritual doesn't apply.
- **Upgrades install in place**: `adb install -r <apk>` for anything signed with the
  release keystore (local script builds, CI `apk` artifacts, tagged releases).
- Earlier the same day, the two stranded practice notes (`Ideas/fun-run.md`,
  `People/Zachary-Hoyt.md`) and their `carnet:history:v1` / `carnet:noteindex:v1` rows
  were deleted via the (then-available) run-as path — then the uninstall wiped everything
  anyway. `Photos/ms.png` existed pre-wipe; gone with the wipe.

**Pixel Fold gotchas discovered** (also in `.omc/skills/pixel-fold-adb-device-ops-expertise.md`):
`adb exec-out screencap` corrupts PNGs with a multi-display warning on stdout; display id
`0` is invalid (query `dumpsys SurfaceFlinger --display-id`); `AlternateBouncerView` in
`mCurrentFocus` = secure bouncer, adb cannot pass it — verify app health via `pidof` +
`ResumedActivity` instead of screenshots when locked.

## Not done / next

- **One-time in-app setup after the wipe (user, on device):** OmniRoute URL
  `http://192.168.1.20:20128` + key + models; Karakeep URL + key; **captureFolderPath**
  → the Syncthing-watched vault folder (was blank even before the wipe; notes are
  app-private-only until set, and post-release there's no adb rescue path).
- **Watch the first dictation tap.** The paused first-tap STT bug
  (2026-07-11 handoff) was only reproducible after a fresh install — this is one. If it
  recurs, resume at hypothesis #2 (permission-dialog race).
- **Smoke-test on device:** dark-mode caret in capture/settings inputs; Karakeep export
  of a note with a non-image attachment (expect the vault-only snackbar, not HTTP 400).
- **OmniRoute dashboard cleanup:** the Mistral provider key is unused since the B2 fold
  (only `/v1/ocr` needed it).
- Backlog unchanged: self-hosted Sentry (fourth handoff mentioning it), minimal ESLint
  (deliberate gap — scope discussion first), desktop app fate (`TODO.md`).
