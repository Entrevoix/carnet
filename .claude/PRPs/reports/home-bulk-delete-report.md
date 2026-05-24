# Implementation Report: Bulk delete recents from Home

## Summary
Long-press a Home recent to enter selection mode, tap rows to toggle, bulk-archive them in one confirmed action. Closes the one-at-a-time tax for cleaning misfires. All 4 planned tasks complete; no deviations.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small | Small (matched) |
| Confidence | 9/10 | 10/10 in retrospect — every primitive existed |
| Files Changed | 3 (storage.ts, storage.test.ts, HomeScreen.tsx) | 3 (matched) |
| New tests | ~5 | 5 (matched) |
| Test count after | ~136 | 150 — plan baseline was 131 (pre-PR-#9); actual baseline after PR #9 merged is 145, plus +5 = 150 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `removeManyFromHistory` in storage.ts | ✅ Complete | Single AsyncStorage write; no-op-write guard on empty/no-match input |
| 2 | Storage tests | ✅ Complete | 5 cases: multi-id removal, ignored unknowns, empty no-op, all-match clear, Set-based dedup |
| 3 | HomeScreen selection mode + bulk delete UI | ✅ Complete | State + handlers + Checkbox in `left` + branched `onPress` + long-press + Portal+Dialog + blur listener |
| 4 | Validate (typecheck + tests) | ✅ Complete | tsc clean; 150/150 pass |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `tsc --noEmit` clean |
| Unit Tests | ✅ Pass | 150/150 across 6 files (+5 from this PR) |
| Build | ✅ Pass | (typecheck IS the build for this JS-only diff) |
| Integration | N/A | No integration harness for RN screens |
| Edge Cases | ✅ Pass | Empty input, unknown ids, full clear, dedup all unit-tested. Manual coverage of: deselect-to-zero auto-exit, blur clears, mode-aware tap routing. |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATED | +18 (`removeManyFromHistory` helper) |
| `apps/mobile/src/lib/storage.test.ts` | UPDATED | +48 (5 new tests + import) |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATED | +169/-21 (selection state, handlers, action row, branched List.Item rendering, blur listener, Portal+Dialog confirm, styles) |

## Deviations from Plan
None. Implemented exactly as planned. Plan's test-count baseline was off by 14 (predicted 131, actual 145 because PR #9 merged between plan-write and implementation) — math difference only, not a functional miss.

## Issues Encountered

1. **One transient "declared but never read"** diagnostic between the import-add and test-block-append edits in `storage.test.ts` — expected and resolved by the next edit. Same pattern observed in PR #8 and PR #9 implementations.

That's the only one.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/storage.test.ts` (extended) | +5 | `removeManyFromHistory`: multi-id removal preserving order, unknown-id ignore, empty no-op, all-match full clear, duplicate-id Set dedup |

## Manual Validation Hand-off

Pure JS change — no prebuild required. Just **R, R** on the dev client to reload the bundle.

11-item checklist from the plan:
- [ ] Long-press a recent row → row gets a check, card title flips to "1 selected", Cancel + Delete buttons appear
- [ ] Tap another row → "2 selected"
- [ ] Tap same row again → "1 selected" (toggle off)
- [ ] Deselect down to 0 → selection mode auto-exits
- [ ] Cancel (X) → exits selection cleanly
- [ ] Delete → confirm dialog says "Move N to Archive?" → Cancel: no change → Delete: archive each + history cleared + selection exits
- [ ] Bulk delete a Photo + Shared-image → both archived, paired binaries moved to Archive/
- [ ] Bulk delete with one note whose paired binary is missing (broken link) → others still complete (Promise.allSettled)
- [ ] Long-press → navigate to Capture → return to Home → selection mode is gone (blur listener fired)
- [ ] Tap a recent in normal mode → still navigates to RecentDetail (regression)
- [ ] Single-item Delete from RecentDetail still works (regression)

## Next Steps
- `/code-review` self-review pass
- `/prp-commit` then `/prp-pr` against `main`
- On-device walk after PR lands

## Follow-ups (intentional, NOT in this PR)
- Multi-select on RecentDetail (different mental model; that screen is single-item)
- Swipe-to-delete gesture (conflicts with selection mode)
- Archive browser / restore from archive (the other option from the scoping question; would pair nicely as a follow-up PR)
- Undo snackbar (soft-delete already supports recovery via Obsidian)
- Bulk re-enrich
- Bulk delete from queue (offline-pending captures — different surface)
