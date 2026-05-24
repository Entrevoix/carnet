# Implementation Report: Retro-enrich from RecentDetail

## Summary
Added a Re-enrich button to RecentDetail for `kind: shared-image` and `kind: photo` notes. Reads the paired image from `Photos/`, re-runs `enrichSharedImage` against the bytes, and overwrites the .md via `updateNote`. Hidden for kinds where re-enrich is meaningless (no recoverable raw input). All 5 planned tasks complete; no deviations.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small | Small (matched) |
| Confidence | 9/10 | 10/10 in retrospect — every primitive existed |
| Files Changed | 2 modified + 1 new helper | 3 modified (writer.ts, writer.test.ts, RecentDetailScreen.tsx) — helpers inline in writer.ts, no new file |
| New tests | ~7 | 15 (4 extractFrontmatterField + 7 mimeFromFilename + 4 readPairedBinaryFromNote) |
| Test count after | ~121 | 145 — plan baseline was 114 (before PR #7 landed); actual baseline once #7 merged is 130, plus +15 = 145 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Promote `extractFrontmatterField` + add `readPairedBinaryFromNote` + `mimeFromFilename` | ✅ Complete | All in writer.ts (no new file needed) |
| 2 | Tests for new helpers | ✅ Complete | 15 tests across 3 describe blocks |
| 3 | Wire Re-enrich button into RecentDetailScreen | ✅ Complete | Button hidden when `!canReEnrich`; in-flight indicator + error banner added |
| 4 | Validate (typecheck + tests) | ✅ Complete | 145/145 pass, `tsc --noEmit` clean |
| 5 | Hand off on-device validation | ⏸️ Handed off | Manual checklist below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `tsc --noEmit` zero errors |
| Unit Tests | ✅ Pass | 145/145 across 6 files |
| Build | ✅ Pass | (typecheck is the build for this JS-only diff) |
| Integration | N/A | No integration harness for RN screens |
| Edge Cases | ✅ Pass | Empty body, no link, broken link, unknown extension, case-insensitive ext — all covered in unit tests |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/writer.ts` | UPDATED | +69 / -2 — exported `extractFrontmatterField`, added `mimeFromFilename` + `readPairedBinaryFromNote` |
| `apps/mobile/src/lib/writer.test.ts` | UPDATED | +106 — 3 new describe blocks (15 tests total) + imports |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATED | +99 / -2 — state (reEnriching, reEnrichError, reEnrichingRef), handleReEnrich callback, canReEnrich derived flag, button, in-flight loader, error banner, inlineLoading style |

## Deviations from Plan
None. Plan called for "2 modified + 1 new helper file"; implemented as 3 modified files with the helpers landing inside the existing `writer.ts` since they compose existing private helpers (`findOrCreateSubdir`, `findFileInDir`, `readBinaryByUri`) — extracting to a new file would require either duplicating those or promoting them too. Inline keeps the surface minimal.

Plan-baseline test count was off (114 vs actual 130 after PR #7 + PR #8 both merged); doesn't affect the implementation, just the report math.

## Issues Encountered

1. **One transient file-modified error** when editing `writer.test.ts` — a re-read after the first edit landed cleanly on retry. No functional impact.
2. **Three "declared but never read"** diagnostics appeared briefly between the import-add edit and the test-block-append edit — expected and resolved by the immediately-following edit. No fix needed.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/writer.test.ts` (extended) | +15 | `extractFrontmatterField`: simple read, missing field, no frontmatter, quoted values. `mimeFromFilename`: image extensions, audio extensions, pdf, unknown→octet-stream, no-extension→octet-stream, case-insensitive. `readPairedBinaryFromNote`: happy-path image, shared-image variant, no link in body, link target missing. |

## Manual Validation Hand-off

Pure JS change — no prebuild required. App on the device already runs from Metro:

- Just **tap RELOAD (R, R)** on the dev client (or close + relaunch) to pick up the bundle
- Walk through the plan's Manual Validation list:
  - [ ] Capture a Photo while OmniRoute is reachable → tap from recents → Re-enrich appears → tap → new LLM body renders
  - [ ] Capture a Photo with OmniRoute offline (force stub) → tap → Re-enrich → succeeds once OmniRoute is back
  - [ ] Share an image with stub fallback → re-enrich from recents → same path
  - [ ] Tap Idea / Journal / Contact recent → NO Re-enrich button visible
  - [ ] Tap shared-link / shared-audio / shared-file recent → NO Re-enrich button
  - [ ] OmniRoute error mid-flight → banner with error; body unchanged
  - [ ] Paired image renamed in Obsidian → "Paired binary not found" banner; body unchanged

## Next Steps
- `/code-review` for a self-review pass
- `/prp-commit` then `/prp-pr` against `main` once on-device validation is green

## Follow-ups not in this PR (intentional)
- **Link / text re-enrich**: needs ShareReceiveScreen to store `source: <url>` in frontmatter at save time so the URL is recoverable. Documented in the plan as follow-up #1.
- **Audio re-transcription**: pairs with slate #4 (native audio recording) and a Whisper-via-OmniRoute path.
- **User-supplied context on re-enrich**: pre-populate a TextInput from the saved `## Context` section. Small follow-up.
- **Diff preview before overwrite**: would be nice, deferred.
