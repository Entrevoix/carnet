# Local Code Review: Retro-enrich from RecentDetail

**Reviewed**: 2026-05-21
**Reviewer**: self (Claude Code)
**Branch**: `feat/recents-retro-enrich` (vs `main`)
**Decision**: APPROVE with comments (L1 applied in-review; L2/L3/L4 noted as follow-ups)

## Summary
Small, focused diff (3 files, +270 lines, 15 new tests). Clean implementation that builds tightly on PR #8's RecentDetail surface and reuses existing internal helpers (`findOrCreateSubdir`, `findFileInDir`, `readBinaryByUri`). No CRITICAL/HIGH/MEDIUM findings; one unused-parameter cleanup applied during the review.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM
None.

### LOW

**L1. `readPairedBinaryFromNote` had an unused `_filepath` parameter — APPLIED**

`apps/mobile/src/lib/writer.ts`. The function operated entirely off `body` + `resolveRoot()` — the file path was never used. Dropped the parameter; updated the single screen call site and the four test call sites. Tests also no longer perform unnecessary `writeIdea` setup calls.

```diff
- export async function readPairedBinaryFromNote(_filepath: string, body: string): Promise<...>
+ export async function readPairedBinaryFromNote(body: string): Promise<...>
```

**L2. Duplicate regex match in `handleReEnrich` + `readPairedBinaryFromNote` — DEFERRED**

`apps/mobile/src/screens/RecentDetailScreen.tsx` matches `/\.\.\/Photos\/([^/\s)]+)/` locally to extract `imageFilename` for `injectImageEmbed`, then calls `readPairedBinaryFromNote(body)` which matches the same regex internally. Both happen back-to-back. Single source of truth would be to have the helper return `{filename, subdir, base64, mime}`.

Reason for deferral: the refactor would change the return type of a function with 4 tests; the two matches are 6 LOC apart in one file. Track as a follow-up if a third caller appears or if the regex needs to change for any reason. Acceptable as-is.

**L3. Link regex doesn't distinguish prose links from links inside fenced code blocks — DEFERRED**

Both the screen and the helper would pick up a `[link](../Photos/foo.jpg)` placed inside ` ``` ` fences. Carnet's own writers never emit such content; relevant only if a user manually puts an example link in a code block via Obsidian. Defense for that case isn't worth the regex complexity today. Note in maintenance.

**L4. `console.warn` for non-fatal errors — Carried from PR #8 review**

`apps/mobile/src/screens/RecentDetailScreen.tsx` `handleReEnrich` uses `console.warn` for the failure path. Matches the pattern in ShareReceiveScreen / PhotoCaptureScreen — project-wide structured-logger upgrade is its own concern, not blocking.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `tsc --noEmit` clean (re-run after L1 fix) |
| Lint | N/A | No `lint` script |
| Tests | ✅ Pass | 145/145 across 6 files |
| Build | N/A | Pure JS diff |

## Files Reviewed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/writer.ts` | Modified | +68 / -2 (after L1 cleanup) |
| `apps/mobile/src/lib/writer.test.ts` | Modified | +100 (after L1 cleanup, removed 4 unused writeIdea calls + 4 destructures) |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | Modified | +96 / -2 (after L1 cleanup) |

## Decision Rationale

Zero CRITICAL/HIGH/MEDIUM; only Low-tier items, one applied and three deferred for documented reasons. CI checks will tell us about regressions across desktop/mobile/shared/gate workflows once the branch pushes.

## Manual validation still pending
The screen-level behavior (button visibility logic per `kind`, in-flight indicator, error banner, body refresh after success) is not unit-testable without RN Testing Library. Manual walk per the plan's checklist still needs to happen on-device after the dev client picks up the new bundle.
