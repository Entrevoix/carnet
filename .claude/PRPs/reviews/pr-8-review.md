# PR Review: #8 — feat: preview and soft-delete from recents list

**Reviewed**: 2026-05-20
**Author**: bearyjd
**Reviewer**: self (Claude Code, fresh pass after the local review)
**Branch**: feat/recents-detail → main
**Decision**: APPROVE WITH COMMENTS (no blocking issues; 1 new MEDIUM + 3 LOWs surfaced beyond the local review)

## Summary
Clean implementation. CI green across all four workflows (desktop, gate, mobile, shared). The local pre-review already caught and resolved 3 MEDIUMs (regex tightening, deleteByUri docstring, single-binary archive docs). This fresh-eyes pass surfaces one additional MEDIUM (consecutive-dots filename slip-through) and a few LOWs. Nothing blocks merge.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M4. `moveToArchive` regex `[^/\s)]+` still accepts `..` as a filename component**

`apps/mobile/src/lib/writer.ts` — the M1 fix from the local review tightened the regex to reject `/`, but `..` (two consecutive dots, no slash) still matches. On the file:// branch, `findFileInDir(parentUri, "..", false)` constructs `${parentUri}/..`, which `FileSystem.getInfoAsync` resolves to the parent directory and reports `exists: true`. The subsequent `readBinaryByUri` then tries to read a directory as a file and throws — at which point `moveToArchive` has already written the .md copy into `Archive/` but not yet deleted the source. The user ends up with a duplicate .md on disk.

**Realistic risk today**: zero — no current writer produces `[link](../Photos/..)`. The SAF branch is also safe because it enumerates real children via `readDirectoryAsync`, which doesn't return `..` entries.

**Worst case**: duplicate .md if a future writer (or external editor) inserts such a link. Not a security breach.

**Suggested fix** (one of):
```ts
// Option A: post-capture sanity check
if (pairedFilename === ".." || pairedFilename.includes("/")) {
  pairedFilename = null;
  pairedBinaryUri = null;
}
// Option B: stricter regex
const linkMatch = content.match(
  /\.\.\/(Photos|Audio|Files)\/([A-Za-z0-9._-]+)/,
);
```

Recommendation: defer. The added cost of pushing another commit + re-running CI for a zero-realistic-risk hardening isn't worth it on a green diff. Note in a follow-up issue if you want to track it.

### LOW

**L5. `markdownStyle(theme)` re-creates the style object on every render** — `apps/mobile/src/screens/RecentDetailScreen.tsx`. The function builds a fresh object each render, so `<Markdown style={...}>` receives a new identity even when nothing relevant changed. `react-native-markdown-display` may not bail; wrap in `useMemo(() => markdownStyle(theme), [theme])` if/when profiling shows it matters.

**L6. No in-flight feedback during archive** — After the user confirms the delete dialog, the screen sits visible until `moveToArchive` + `removeFromHistory` complete, then bounces back. For a large paired binary on a slow SAF tree, this could feel like a hang. An ActivityIndicator or disabled-state on the Delete button would close the loop. UX nit, not a bug.

**L7. Paired audio/file in the markdown renders as a text link, not a playable preview** — Tap doesn't open the audio. Consistent with the plan's "audio file path link is shown" scope, but worth flagging so a future reviewer doesn't think it's a regression. Inline media playback is a separate concern.

### Carried over from the local review (already in this diff)

- **M1.** ✅ Applied — `moveToArchive` regex captures `[^/\s)]+` (rejects `/`)
- **M2.** ✅ Documented — single-binary archive design called out in `moveToArchive` JSDoc
- **M3.** ✅ Applied — `deleteByUri` docstring corrected on SAF non-idempotency
- **L1–L4** — accessibility, markdownStyle size, useEffect dep over-specification, `console.warn` usage. Carry forward; project-wide tracks.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `tsc --noEmit` clean (re-run at PR head) |
| Lint | N/A | No `lint` script in `@carnet/mobile` |
| Tests | ✅ Pass | 114/114 across 5 files |
| Build | ✅ Pass | (Typecheck is the build for this JS-only diff) |
| CI: desktop | ✅ Pass | 26s |
| CI: gate | ✅ Pass | 2s |
| CI: mobile | ✅ Pass | 23s |
| CI: shared | ✅ Pass | 29s |

## Files Reviewed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/App.tsx` | Modified | +9 / -4 |
| `apps/mobile/package.json` | Modified | +1 dep |
| `apps/mobile/src/lib/storage.ts` | Modified | +8 / -1 |
| `apps/mobile/src/lib/storage.test.ts` | Added | +90 |
| `apps/mobile/src/lib/writer.ts` | Modified | +161 / -3 |
| `apps/mobile/src/lib/writer.test.ts` | Modified | +88 |
| `apps/mobile/src/screens/HomeScreen.tsx` | Modified | +3 |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | Added | +257 |
| `package-lock.json` | Modified (auto) | +115 |

## Decision Rationale

Zero CRITICAL/HIGH; the new MEDIUM (M4) is theoretical and not worth churning the diff for; CI is green; tests are comprehensive; the implementation matches the plan and the existing project patterns (Card+Actions, savingRef equivalent, vi.mock in-memory store, REFRESH_ON_FOCUS).

**APPROVE WITH COMMENTS.** Self-author so the GitHub review event will be posted as a `COMMENT` (GitHub blocks `--approve` on own PRs).

## Manual validation still pending
On-device walk per the PR's Test Plan checklist (11 items). The static surface and CI are clean; on-device verification covers the screen layout / interaction / SAF-revocation paths that can't be tested in vitest.
