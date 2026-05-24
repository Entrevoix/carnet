# Implementation Report: Native audio recording (slate #4)

## Summary
Added a 5th capture mode "Audio" to carnet. New `AudioCaptureScreen` records via expo-av's `Audio.Recording`, saves the resulting `.m4a` to the vault's `Audio/` subdir, and writes a stub markdown note to `Ideas/` with `kind: shared-audio` — same shape as PR #7's share-audio branch so downstream code (RecentDetail render, moveToArchive paired-binary detection, future transcription) handles share + capture identically. Transcription deferred to a follow-up PR as scoped.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 9/10 | 9/10 — landed clean |
| Files Changed | 1 new + 4 modified | 1 new + 4 modified |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extend CaptureMode union with "audio" | Complete | One-line union extension in storage.ts |
| 2 | Update formatMode/modeIcon switches | Complete | Cases added in HomeScreen + RecentDetail |
| 3 | Add 5th Home button (Audio) | Complete | Outlined button with microphone-outline icon |
| 4 | Create AudioCaptureScreen.tsx | Complete | 4-phase state machine with pulse animation |
| 5 | Register AudioCapture route + deep link | Complete | RootStackParamList + Stack.Screen + carnet://audio |
| 6 | Validate (typecheck + tests) | Complete | 0 type errors, 161/161 tests pass |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean (LSP cache shows stale errors but real tsc passes) |
| Unit Tests | Pass | 161/161 — no new tests written (UI + expo-av not unit-testable without heavy mocking, as scoped in plan) |
| Build | N/A | JS-only changes; live-reloads on dev client |
| Integration | N/A | On-device manual validation needed |
| Edge Cases | N/A | On-device manual validation needed |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/screens/AudioCaptureScreen.tsx` | CREATED | +335 |
| `apps/mobile/src/lib/storage.ts` | UPDATED | +1 / -1 |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATED | +14 / -0 |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATED | +2 / -0 |
| `apps/mobile/App.tsx` | UPDATED | +7 / -0 |

## Deviations from Plan
None — implemented exactly as planned. The pulse animation, double-tap guards (`startingRef` + `savingRef`), cache-file cleanup, and the `kind: shared-audio` reuse all matched the spec.

## Issues Encountered
- **Stale LSP diagnostics during incremental edits** — Same false-alarm pattern as past sessions: LSP didn't repopulate after App.tsx's `RootStackParamList` update, surfacing "AudioCapture not assignable" errors. Real `tsc --noEmit` passes clean. No action needed; documented for future reference.

## Tests Written
None — as scoped in the plan. The recording state machine + expo-av integration aren't unit-testable without mocking the entire Audio module (mock-vs-test ratio not worth it). Downstream save path (writeBinary + writeIdea + recordCapture) is already covered by writer.test.ts and storage.test.ts.

## On-Device Validation Checklist
- [ ] Home shows 5 buttons (Idea / Journal / Contact / Photo / Audio)
- [ ] Tap Audio → AudioCapture screen with the big record button
- [ ] Tap record → permission prompt (first time) → recording starts → timer increments → pulsing red REC dot
- [ ] Tap Stop & save → "Saved to vault" card → Done → back to Home
- [ ] New entry appears in recents with mic-outline icon and "Audio · Xs ago" subtitle
- [ ] Tap the recent → RecentDetail renders the stub markdown with the `../Audio/...` link
- [ ] Long-press recent → enters selection mode (regression)
- [ ] Delete from RecentDetail → both .md and .m4a move to Archive/
- [ ] Record → tap Cancel → no file in Audio/ or Ideas/; cache file cleaned
- [ ] Record → back button → no orphaned mic indicator in status bar
- [ ] Deep link: `adb shell am start -W -a android.intent.action.VIEW -d "carnet://audio" us.beary.carnet` lands on AudioCapture

## Next Steps
- [ ] On-device QA (see checklist above)
- [ ] Commit via `/prp-commit`
- [ ] PR via `/prp-pr`
- [ ] Follow-up PR: transcription (OmniRoute Whisper path) — works on both `kind: shared-audio` capture + share entries
- [ ] Optional follow-up: add 5th `audio` shortcut to `withAppShortcuts.js` once recording UX validated
