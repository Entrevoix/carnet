# Plan: Sync-conflict visibility

Status: shipped (2026-07-17, same-day)
Date: 2026-07-17
Origin: 2026-07-17 market research finding #2 — sync-conflict clutter is a top
validated Obsidian-mobile pain; Syncthing resolves conflicts by writing
`*.sync-conflict-*` copies that silently accumulate. Also shapes TODO.md's
deferred "Bidirectional sync awareness" item.

## Bug found while scoping (makes this partly a FIX, not just a feature)

`writer.listNoteFiles()` includes every `*.md` in Ideas/Journal/People — so a
Syncthing conflict copy (`note.sync-conflict-20260716-093012-ABC123.md`) is
TODAY indexed as a normal note: it appears in Search results, inflates tag
counts, and can be opened/edited as if canonical. Nothing in the app knows
conflicts exist (`grep sync-conflict` matches only a writer.ts comment).

## Scope (MVP — visibility, not merge)

1. **`lib/syncConflicts.ts`** (new, ~80 ln + tests)
   - `SYNC_CONFLICT_RE` matching Syncthing's documented pattern:
     `<stem>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device7>.<ext>` (case-insensitive,
     tolerate unknown device-id lengths).
   - `isSyncConflictName(name)`, `conflictOriginalName(name)` (strip the marker →
     the canonical filename), pure + tested.
   - `listSyncConflicts(): Promise<ConflictRef[]>` — enumerate the three note
     subdirs (same listing primitive as listNoteFiles), return
     `{uri, name, subdir, originalName, originalUri | null}` pairs (original
     resolved by name in the same subdir; null when the original is gone).
     Markdown only in MVP; binary conflicts (Photos/…) deferred.

2. **Index hygiene — `writer.listNoteFiles()`** filters `isSyncConflictName`
   (one-line + import). Fixes the pollution bug for Search/tags/Home join.
   A vault.ts index rebuild after update naturally drops the phantom entries.

3. **Home banner** (mirrors the pending-Karakeep banner pattern):
   - Count from `listSyncConflicts()` during `refresh()` (cheap: one dir listing
     per subdir; no note reads).
   - `Banner`: "N sync conflict(s) in the vault — Review" → opens a dialog
     listing each conflict (name + relative age) with actions per row:
     **Open copy** / **Open original** (both navigate to RecentDetail with a
     synthesized entry — `vault.synthesizeEntry` exists) — the user compares and
     deletes the loser via RecentDetail's existing archive-delete.
   - No merge UI in MVP (research: visibility is the gap; merge is Obsidian-side).

4. **Tests**
   - `syncConflicts.test.ts`: regex matrix (real Syncthing names, near-misses,
     case, non-md), original-name derivation, listSyncConflicts with mocked
     listing (present/missing original).
   - `writer.test.ts` (+SAF variant): listNoteFiles excludes conflict names.
   - `HomeScreen.test.tsx`: banner renders at N>0, absent at 0, dialog lists
     rows (mock `../lib/syncConflicts`).

## Non-goals (explicit)
- No auto-resolution/merge, no diff view (Obsidian on the workstation is the
  merge surface; carnet's job is to make the state VISIBLE on mobile).
- No file watcher (TODO.md's full "bidirectional sync awareness" stays deferred);
  detection is scan-time (focus/refresh), matching the index's cache-first model.
- No Archive/ or binary-subdir conflict scanning in MVP.

## Risks
- Regex must not false-positive on legitimate filenames containing
  "sync-conflict" (regex anchors on the full Syncthing marker incl. timestamp).
- listNoteFiles is shared by index + journalTagIndex + search — filtering there
  is the single choke point (right place), but verify no consumer WANTS
  conflicts (none do today; Search showing them is the bug).
- Coordination: writer.ts is mid-VaultFs-refactor on this tree — implement
  AFTER that lands to avoid a rebase mess (the listNoteFiles edit is 2 lines
  wherever it ends up).

## Estimate
S-M: one new lib module + tests, a 2-line writer filter, one banner + dialog on
Home, smoke tests. No settings, no native, no schema changes.
