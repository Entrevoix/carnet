# Implementation Report: Recents browse + preview + delete

## Summary
Made the recents list tappable, added a read-only RecentDetail screen that renders the saved markdown with react-native-markdown-display, and a soft-delete flow that moves the .md + any paired binary (Photos/Audio/Files) to an `Archive/` subdir before dropping the entry from history. Bumped HISTORY_LIMIT from 5 to 20. All 9 planned tasks complete; no plan deviations beyond a one-line Paper type fix (`MD3Theme` vs `ReturnType<typeof useTheme>`).

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium (matched) |
| Confidence | 8/10 | 9/10 in retrospect — fewer unknowns than expected |
| Files Changed | 7 (5 modified + 2 new) | 7 (5 modified + 2 new) — matched |
| New tests | ~9 | 14 (7 storage + 7 writer additions, broader edge coverage than planned) |
| Test count after | ~126 | 114 — plan baseline of 117 assumed PR #7 had merged; the actual main baseline is 100, so +14 → 114 is consistent |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Bump HISTORY_LIMIT + add removeFromHistory | ✅ Complete | |
| 2 | Add moveToArchive in writer.ts + promote stripFrontmatter | ✅ Complete | 3 private helpers (readBinaryByUri / writeBinaryBytes / deleteByUri) added next to readByUri/writeByUri |
| 3 | Install react-native-markdown-display | ✅ Complete | v7.0.2 added; pure JS, no prebuild required |
| 4 | Create RecentDetailScreen.tsx | ✅ Complete | ~260 lines incl. theme-aware markdownStyle and Dialog confirm; lightly above the 150-200 estimate because of the explicit markdown style block |
| 5 | Register in App.tsx + make Home recents tappable | ✅ Complete | |
| 6 | storage.test.ts (5 tests planned) | ✅ Complete | 7 tests written (added: empty-store removeFromHistory, corrupted JSON returns []) |
| 7 | writer.test.ts moveToArchive cases (4 tests planned) | ✅ Complete | 7 tests written (added: 3 stripFrontmatter cases) |
| 8 | Run validation suite | ✅ Complete | Typecheck clean; 114/114 tests pass across 5 files |
| 9 | On-device manual validation | ⏸️ Handed off | Command surfaced; not auto-run (5-10 min device rebuild) |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `tsc --noEmit` zero errors |
| Unit Tests | ✅ Pass | 114 tests across 5 files: urlpreview (20), storage (7 new), queue (10), writer (53), omniroute (24) |
| Build | ✅ Pass | Typecheck IS the build for the JS surface; no native rebuild attempted (no native module added) |
| Integration | N/A | No integration test harness for RN screens in this repo |
| Edge Cases | ✅ Pass | Empty store, corrupted JSON, missing paired binary, collision-bumped archive, removeFromHistory on empty / missing id all covered |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATED | +8 / -1 |
| `apps/mobile/src/lib/writer.ts` | UPDATED | +150 / -2 |
| `apps/mobile/src/lib/writer.test.ts` | UPDATED | +88 (deleteAsync mock + 7 tests) |
| `apps/mobile/src/lib/storage.test.ts` | CREATED | +85 |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATED | +3 (onPress wiring) |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | CREATED | +260 |
| `apps/mobile/App.tsx` | UPDATED | +9 / -4 |
| `apps/mobile/package.json` | UPDATED | +1 dep |
| `package-lock.json` | UPDATED (auto) | +115 |

## Deviations from Plan

1. **`MD3Theme` import for `markdownStyle` parameter** (RecentDetailScreen.tsx). Plan used `theme: ReturnType<typeof useTheme>` which TypeScript resolves to `unknown` (the Paper generic isn't inferrable from a bare `useTheme` import). Fix: import `MD3Theme` from `react-native-paper` and type the parameter directly. One-line change, no semantic difference.
2. **Test count higher than planned** — wrote 14 new tests vs the planned ~9 because the edge cases were trivial to add once the test files existed (empty store, corrupted JSON, stripFrontmatter unterminated block). Worth the marginal cost.
3. **Plan's test-count baseline was off** — assumed PR #7 (shareHelpers + extFromMime audio cases) had already merged. It hasn't, so the baseline is 100, not 117. Final count 114 instead of "~126." Functionally identical outcome.

## Issues Encountered

1. **First typecheck after `RecentDetailScreen.tsx` failed** — 13 errors. Root causes:
   - `"RecentDetail"` not yet in `RootStackParamList` (expected — Task 5 wasn't done yet; resolved when Task 5 ran)
   - `theme` typed as `unknown` (the `MD3Theme` deviation above; resolved by importing `MD3Theme`)
   
   Both fixed without re-architecture. The LSP also reported stale diagnostics about PhotoCaptureScreen and the RecentDetail nav key for a moment after Task 5; `tsc --noEmit` was authoritative and clean.

2. **No issues with `react-native-markdown-display` install** — peer-dep warning didn't surface. The fork-fallback risk noted in the plan turned out not to be needed.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/storage.test.ts` (new) | 7 | `getRecentCaptures` empty/corrupted, `recordCapture` MRU + cap, `removeFromHistory` by id / unknown id / empty store |
| `apps/mobile/src/lib/writer.test.ts` (extended) | +7 | `stripFrontmatter` (3 cases: present, absent, unterminated) + `moveToArchive` (4 cases: standalone, paired binary, broken link, collision bump) |

No tests for the screen itself — the helpers it composes are unit-tested, and the screen layout/interaction is covered by the manual validation checklist below.

## Manual Validation Hand-off

Pure JS dep — no prebuild needed. From `/home/user/Documents/vibe-code/carnet/apps/mobile`:

```bash
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk \
  PATH="/home/user/Android/Sdk/platform-tools:$PATH" \
  npx expo run:android
```

Then walk the checklist in `.claude/PRPs/plans/recents-screen-preview-delete.plan.md` "Manual Validation" section (11 items).

## Next Steps
- [ ] `/code-review` against the diff
- [ ] On-device manual validation (above)
- [ ] `/prp-commit` — bundle into a single `feat:` commit (the 9 untracked + modified files all serve one feature)
- [ ] `/prp-pr` — open PR against `main`

## Open threads not addressed by this PR (intentional)
- Inline edit (slate item #6) — separate PR; replaces the `<Markdown>` block with a `<TextInput multiline>` and calls `updateNote` on save
- Retro-enrich (slate item #5) — separate PR; reuses `enrichSharedImage`/`enrichSharedLink` keyed on `kind` from the frontmatter
- Browse-by-kind tabs, full-text search — separate, deferred
- PR #7 (audio + arbitrary file shares) is still pending merge; this branch is independent of it and can land first
