# Implementation Report: Auto-transcribe on save (v0.4 S1)

## Summary
New opt-in Settings toggle `autoTranscribeOnSave`. When on, audio captures (in-app recording AND share-receive audio) automatically run through Whisper after save. The saved screen renders immediately with an inline "Transcribing audio…" indicator that resolves when the transcript lands in the note. Removes the per-recent "tap Transcribe" step for users who always want transcripts.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 9/10 | 9/10 — landed clean |
| Files Changed | 1 helper + 4 modified + 1 test | 5 modified + 1 test extended |

## Tasks Completed
| # | Task | Status |
|---|---|---|
| 1 | Add `autoTranscribeOnSave` field to Settings | Complete |
| 2 | Wire Switch in SettingsScreen | Complete |
| 3 | Add `autoTranscribeIfEnabled` helper to omniroute.ts | Complete |
| 4 | Fire auto-transcribe from AudioCaptureScreen | Complete |
| 5 | Fire auto-transcribe from ShareReceiveScreen audio branch | Complete |
| 6 | Tests for `autoTranscribeIfEnabled` | Complete (+6 cases) |
| 7 | Final typecheck + tests | Complete — 0 errors, 214/214 |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean |
| Unit Tests | Pass | 214/214 (was 208; +6 helper tests) |
| Build | N/A | JS-only |
| On-Device | PENDING | Toggle + recording + share-audio flows need device verification |

## Files Changed
| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/omniroute.ts` | UPDATE | +47 (helper + import) |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATE | +180 (writer mock + 6 helper tests + global fixture updates) |
| `apps/mobile/src/lib/settings.ts` | UPDATE | +14 (field + migration) |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | +35 (FormState field + AI behavior section UI) |
| `apps/mobile/src/screens/AudioCaptureScreen.tsx` | UPDATE | +56 (state + mounted ref + hook + inline indicator) |
| `apps/mobile/src/screens/ShareReceiveScreen.tsx` | UPDATE | +55 (state + mounted ref + audio-only gate + indicator) |

## Deviations from Plan
None of substance. Helper landed exactly as specced; both screen integrations follow the documented fire-and-forget + mountedRef pattern.

## Issues Encountered
- Linter cache lost `AudioCaptureScreen.tsx` between turns — had to re-read once before applying edits. No code lost.
- `vi.mock("./writer")` at the file top potentially affected other tests; verified existing tests don't import from writer in omniroute.test.ts so the mock is contained to the new describe block.

## On-Device QA Checklist (REQUIRED)
- [ ] Settings → new "AI behavior" section appears above Capture surfaces
- [ ] Switch "Auto-transcribe audio on save" with HelperText about API cost
- [ ] Toggle OFF → record + save → no transcription, no inline indicator (existing behavior)
- [ ] Toggle ON → record + save → saved screen appears immediately with "Transcribing audio…" spinner row
- [ ] Indicator resolves silently to info HelperText when transcribe succeeds; note has `## Transcript` on next view
- [ ] Wrong API key with toggle ON → "Auto-transcribe failed: ... 401 ..." HelperText (Bearer redacted)
- [ ] >25MB recording with toggle ON → "Auto-transcribe failed: Audio is XX MB..." HelperText
- [ ] Tap Done before transcribe completes → no React warning in logcat; note still has transcript on next open
- [ ] Share an audio file with toggle ON → ShareReceive saved screen shows the same indicator
- [ ] Share a non-audio file with toggle ON → no transcription attempted, regular flow
- [ ] Regression: manual Transcribe button on RecentDetail still works (and can re-run after auto-transcribe failed)

## Next Steps
- [ ] On-device QA
- [ ] `/prp-commit` + `/prp-pr`
- [ ] Optional v0.4 follow-up: chain S1 → S2 polish when S2 ships ("auto-polish after auto-transcribe" toggle)
