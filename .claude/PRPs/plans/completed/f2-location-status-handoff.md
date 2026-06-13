# Handoff: capture-metadata suite COMPLETE — F2 merged, repo glow-up shipped

> ✅ Handoff for F2 Location — SHIPPED (#40 787688b, on-device smoke passed). Archived snapshot.

> Self-contained status as of **2026-06-11** (session end). Supersedes the earlier
> "F2 BUILT / PR #40 OPEN / smoke BLOCKED" version — all of that is now DONE.
> Bridges a `/clear`. Working tree is on `main`, clean except the untracked plan docs
> in this folder + the `.claude/scheduled_tasks.lock` heartbeat.

## TL;DR
- **F2 Location → MERGED** (PR #40, squash `787688b`). On-device smoke **PASSED**. `main` is at `0fb7d1c`.
- **Capture-metadata suite COMPLETE & fully merged**: Task 0 frontmatter (#36), F1 WYSIWYG editor (#35), F3 Tags (#38/#39), F2 Location (#40). Nothing left in the suite.
- **Repo glow-up → MERGED** (PR #41, squash `0fb7d1c`): README hero banner+badges, AGPL-3.0 `LICENSE`, `docs/CODEMAPS/`, `docs/CONTRIBUTING.md`, `docs/RUNBOOK.md`. GitHub About refreshed (desc + 14 topics). Social-preview card uploaded by the user. Done.
- **claude-mem updated 13.0.1 → 13.5.6** (marketplace clone fast-forwarded + reinstalled) to fix the PostToolUse stdin/#2188 "Malformed JSON at stdin EOF" hook noise. **Verify it's quiet in the NEXT fresh session** — this session still ran 13.0.1 in memory.

## F2 — DONE (what shipped + how it was verified)
Stored as a plain `location: lat,lon` string in note frontmatter (no map, no address object).
- `src/lib/location.ts` (pure `formatCoords`/`parseCoords` 5-dp range-checked + `getCurrentCoords` permission wrapper + `describeCoords` display-only reverse geocode; `expo-location ~19.0.8`), `LocationChip.tsx`, dual-path frontmatter injection (`confirmSave` + offline `processRow`), `appendJournal` carries journal location onto the day file (latest-wins; [[appendjournal-strips-entry-frontmatter]]), RecentDetail tappable `geo:` chip.
- **On-device smoke PASSED** (Pixel 10 Pro Fold `57211FDCG0023C`, the installed #40 APK, user unlocked PIN): Location+Enter render below Tags ✓; tap Location → real fix → chip `San Francisco, California · 37.78735,-122.40865` ✓; ✕ removes/reverts ✓; manual Enter `40.71280,-74.00600` → `New York, New York · …` ✓; bad input `200,999` → error helper `"Enter coordinates as lat,lon (e.g. 38.9072,-77.0369)."`, no chip ✓. NON-DESTRUCTIVE (no Send/Save).
- **metro-runtime build trap — DURABLY FIXED** (in the #40 squash): pinned `metro-runtime: "0.83.3"` in root `package.json` so `npm install` keeps the hoisted copy `@expo/cli` needs for the release JS bundle. Re-pin to match `metro` after any Expo/metro bump.

## ONLY un-exercised F2 piece (optional, deferred)
Full capture → **RecentDetail geo-chip display** on-device — skipped because it writes a real note into the Syncthing vault. The data path is covered by the 460 unit tests; only the RN display of the geo chip is unverified on-device. Do it as a disposable note (then archive) if desired.

## Remaining project backlog (NOT this session)
- **editor-web picture insert** — `.claude/PRPs/plans/wysiwyg-editor-web-enhancements.plan.md` (in-WebView local-file display under baseURL `https://localhost/`; data-URI swap recommended).
- **STT device-side** — download the on-device speech model + full speak-test QA ([[pixel-stt-device-recognizer-health]]).
- WYSIWYG full status: `.claude/PRPs/plans/wysiwyg-native-editor-status-handoff.md`.

## On-device QA quirks ([[pixel-fold-on-device-qa-quirks]])
- Pin `ANDROID_SERIAL` (two foldables may be attached). Devices PIN-lock themselves — adb CANNOT unlock; needs the user. Keep awake with `adb shell svc power stayon true`.
- Screenshots via `screencap -p /sdcard/x.png && adb pull` (NOT `exec-out`). Live UI via `uiautomator dump`.
- The location chip is **content-width** → the ✕ hit-target moves with label length; re-dump bounds per chip rather than reusing coords.

## Build command
`cd apps/mobile && ANDROID_SERIAL=<serial> ANDROID_HOME=/home/user/Android/Sdk npm run android:release` (auto-installs). New native module → `npx expo prebuild -p android --no-install` first.

## Memory pointers
[[backlog-prp-plans]] (suite COMPLETE; F2 = #40 merged), [[appendjournal-strips-entry-frontmatter]], [[build-env-no-google-maven-fetch]] (cached deps let expo-location build), [[pixel-fold-on-device-qa-quirks]], [[pixel-stt-device-recognizer-health]].
