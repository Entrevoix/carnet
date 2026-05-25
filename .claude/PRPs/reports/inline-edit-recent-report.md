# Implementation Report: Inline edit a recent capture (slate #6)

## Summary
RecentDetail gets an Edit mode. Pencil button → multiline TextInput showing full note content (frontmatter + body). Save persists via updateNote, re-derives the recents title if H1 changed, updates AsyncStorage. Cancel discards. Hard unsaved-changes guard on back-navigation via beforeRemove. Closes the read/write loop for recents — typo fixes no longer require opening Obsidian.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 9/10 | 9/10 — landed clean |
| Files Changed | 3 modified + 1 test | 3 modified |

## Tasks Completed
| # | Task | Status |
|---|---|---|
| 1 | Add `updateCaptureTitle` to storage.ts | Complete |
| 2 | Wire Edit mode in RecentDetailScreen | Complete |
| 3 | Tests for updateCaptureTitle | Complete (+4 cases) |
| 4 | Validate (typecheck + tests) | Complete — 0 errors, 208/208 |
| 5 | Devil's advocate review | Complete — 2 items applied (mounted-ref, split try blocks) |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean |
| Unit Tests | Pass | 208/208 (was 204; +4 storage tests) |
| Build | N/A | JS-only, live-reloads on dev client |
| On-Device | PENDING | Edit-mode + beforeRemove guard need device verification |

## Files Changed
| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATE | +21 |
| `apps/mobile/src/lib/storage.test.ts` | UPDATE | +45 (4 new cases + AsyncStorage import) |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | +175 / -30 |

## Devil's-advocate fixes applied (2 of 2)
1. **Split handleSaveEdit try blocks** — disk write owns its own try; title update is best-effort (warn-only) so an AsyncStorage failure after successful disk write no longer misleads the user with "Save failed"
2. **Mounted ref** — eliminates setState-on-unmount warnings when user navigates back during an in-flight save (the disk write itself still lands; only the post-write setState is skipped)

## Deviations from Plan
None. Implemented as planned plus the 2 review items.

## On-Device QA Checklist (REQUIRED)
- [ ] RecentDetail shows new pencil "Edit" button (first in Card.Actions, before Delete)
- [ ] Tap Edit → markdown body card hides, TextInput card appears with full content
- [ ] Edit content → Save button enables (was disabled while !isDirty)
- [ ] Edit and tap Save → returns to view mode with new content rendered
- [ ] Edit H1 and Save → recents list on Home shows the new title after navigating back
- [ ] Edit body without changing H1 → no storage write for title (silent no-op)
- [ ] Tap Cancel with no changes → exits silently
- [ ] Tap Cancel with changes → discard dialog → Keep editing keeps state → Discard exits
- [ ] System back button with dirty draft → same discard dialog
- [ ] Discard dialog backdrop tap → keeps editing (safe default)
- [ ] Edit + Save when offline / write fails → "Save failed" banner with reason
- [ ] Edit while note is missing → Edit button is disabled (consistent with Delete/Transcribe)
- [ ] Regression: Re-enrich button still works on shared-image / photo
- [ ] Regression: Transcribe button still works on shared-audio
- [ ] Regression: Delete still archives

## Next Steps
- [ ] On-device QA
- [ ] `/prp-commit` then `/prp-pr`
- [ ] Optional follow-up: file rename via a second Edit field
