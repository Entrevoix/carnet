# Local Code Review: Recents browse + preview + delete

**Reviewed**: 2026-05-19
**Reviewer**: self (Claude Code)
**Branch**: `feat/recents-detail` (vs `main`)
**Decision**: APPROVE with comments (MEDIUMs M1/M3 applied in-review; M2 documented; LOWs noted)

## Summary
Implementation is clean, well-tested, and consistent with project patterns (Card+Actions layout, `savingRef` in-flight guard, vi.mock in-memory store for tests). One real defense-in-depth issue caught (`moveToArchive` regex permissiveness) and fixed in this review. Two MEDIUM items: regex tightening (fixed), docstring honesty (fixed). One MEDIUM design note: single-binary archive (documented in JSDoc, deferred). No CRITICAL or HIGH findings.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M1. `moveToArchive` regex allowed path traversal characters in the captured filename — APPLIED**

`apps/mobile/src/lib/writer.ts` — the link-target regex was `/\.\.\/(Photos|Audio|Files)\/([^\s)]+)/`. The `[^\s)]+` capture accepted `/`, which let a hypothetical markdown body containing `[link](../Photos/../../sensitive)` cause `findFileInDir` to resolve through the traversal, archive the target, and delete the original.

Realistic risk today: zero — every writer in the codebase passes a slugified `[a-z0-9-]` filename to the link target. Defense-in-depth fix: change capture to `[^/\s)]+`.

```diff
- const linkMatch = content.match(/\.\.\/(Photos|Audio|Files)\/([^\s)]+)/);
+ const linkMatch = content.match(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/);
```

Added a comment explaining the rationale so a future contributor doesn't relax it.

**M2. `moveToArchive` finds only the first paired binary — DOCUMENTED, not fixed**

`content.match(...)` returns the first match. Today every writer emits exactly one paired-binary link per note, so this is correct. A future code path with multiple paired binaries would orphan all but the first.

Action taken: JSDoc on `moveToArchive` now explicitly calls out the single-binary design and the `matchAll` migration path if/when a multi-binary writer lands.

**M3. `deleteByUri` docstring overstated SAF idempotency — APPLIED**

The original comment said SAF deleteAsync throws on revoked permission; in reality it also throws when the file is already gone. Caller-side try/catch in `moveToArchive` was already correct, but the helper's docstring misled. Tightened to be honest.

### LOW

- **L1.** No `accessibilityRole="button"` on the tappable `List.Item` in HomeScreen. Project-wide gap — HomeScreen's existing IconButton settings cog also lacks an a11y label. Not blocking; track as a follow-up across all screens.
- **L2.** `markdownStyle()` is ~37 lines of style construction. Readable; extract to a sibling helper if it grows.
- **L3.** `useEffect(...)` dep array `[entry.filepath]` is technically over-specified (entry never mutates during the screen's lifetime). Harmless React idiom.
- **L4.** `console.warn` for non-fatal errors. Matches existing pattern in ShareReceiveScreen / PhotoCaptureScreen. Project-wide upgrade to a structured logger is a separate concern.

## Validation Results

| Check | Result |
|---|---|
| Type check | ✅ Pass (`npm -w @carnet/mobile run typecheck`) |
| Lint | N/A (no separate lint script) |
| Tests | ✅ 114/114 across 5 files (incl. 7 new storage + 7 new writer tests) |
| Build | N/A (pure JS additions, no native rebuild required) |

## Files Reviewed

| File | Action | Change |
|---|---|---|
| `apps/mobile/App.tsx` | Modified | +9 / -4 — register RecentDetail in stack |
| `apps/mobile/package.json` | Modified | +1 dep (`react-native-markdown-display@^7.0.2`) |
| `apps/mobile/src/lib/storage.ts` | Modified | +8 / -1 — `HISTORY_LIMIT` 5→20 + `removeFromHistory` |
| `apps/mobile/src/lib/storage.test.ts` | Added | +85 (7 tests) |
| `apps/mobile/src/lib/writer.ts` | Modified | +150 / -2 — `moveToArchive`, 3 private helpers, `stripFrontmatter` exported |
| `apps/mobile/src/lib/writer.test.ts` | Modified | +88 — `deleteAsync` mock, 3 `stripFrontmatter` cases, 4 `moveToArchive` cases |
| `apps/mobile/src/screens/HomeScreen.tsx` | Modified | +3 — `onPress` wiring on recents rows |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | Added | +260 — read-only markdown render, paired-binary aware, delete-with-confirm, missing-file banner |

## Notes
- The path-traversal defense-in-depth fix (M1) hardens against a hypothetical future writer that doesn't sanitize a link target. It does not protect against a user manually editing their own vault and crafting a traversal — that's outside the threat model (user attacking themselves).
- On-device manual validation per the plan's 11-item checklist is still pending; this review covered only the static surface.
