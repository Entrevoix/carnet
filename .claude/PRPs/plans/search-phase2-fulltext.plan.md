# Plan: Search Phase 2 — on-demand full-text search

Status: design, approved by user, ready for implementation plan
Date: 2026-07-19
Origin: `.claude/PRPs/prds/v0.5-browse-search.prd.md` §"Phase 2 — on-demand
full-text search" (design, not scheduled, 2026-07-04). Phase 1 (note-metadata
index + Search screen) shipped in PR #67. Phase 3 (retrospective query) stays
blocked — it's explicitly gated on v0.4 S4 (embeddings), which was never
shipped (`git log` shows no S4 commit; `findRelatedNotes` in `relatedNotes.ts`
is a separate local heuristic unrelated to the embeddings-bridge design). This
plan scopes Phase 2 only.

## Problem

Phase 1's Search screen ranks over `title` → `tags` → `excerpt` (the first
~200 chars of a note's stripped body, captured at index time). A note whose
match only occurs *later* in the body is invisible to Phase 1 search — the
index deliberately doesn't store full bodies (AsyncStorage blob-size ceiling,
see the PRD's risk table). Phase 2 closes that gap with an explicit,
on-demand escape hatch: scan actual note bodies only when the user asks for
it.

## Design

### `vault.ts` — `searchNoteBodies`

New function alongside `searchNotes`/`buildNoteIndex`, sharing the existing
`mapWithConcurrency` helper and `SCAN_CONCURRENCY` (8):

```ts
export interface BodyMatch {
  uri: string;
  snippet: string; // ~80 chars centered on the first match
}

export function searchNoteBodies(
  query: string,
  onMatch: (match: BodyMatch) => void,
  signal: AbortSignal,
): Promise<{ scanned: number; total: number }>
```

- `listNoteFiles()` for the full file list (same enumeration Phase 1 uses).
- `mapWithConcurrency` reads each note body (`readNote`) at concurrency 8;
  before starting each unit of work, check `signal.aborted` and bail out
  early (no new reads issued after cancel; in-flight reads are allowed to
  finish rather than aborted mid-IPC-call, since SAF has no cancel primitive).
- Case-insensitive substring match against `stripFrontmatter(markdown)` (not
  `makeExcerpt`, which anchors at position 0 and strips a leading H1 — this
  needs to find the match position, not build a fixed excerpt).
- On a match: extract a window (~40 chars each side of the first match,
  clamped to string bounds, `…` prefix/suffix when truncated) as `snippet`,
  call `onMatch({ uri, snippet })` immediately (streaming, not collected into
  an array), don't wait for the full scan.
- Return `{ scanned, total }` when the scan completes or is cancelled, so the
  caller can show a final "N of M notes scanned" state.
- Unreadable notes (deleted mid-scan, SAF permission revoked) are skipped
  silently, matching `buildNoteIndex`'s existing behavior — not a fatal error.

### `SearchScreen.tsx`

- New state: `bodyMatches: BodyMatch[]`, `bodyScan: "idle" | "scanning" |
  "done" | "cancelled"`, `bodyScanProgress: { scanned: number; total: number
  }`, plus an `AbortController` ref to cancel on unmount/query-change/explicit
  cancel tap.
- Below the existing index-results `FlatList`, when `query.trim()` is
  non-empty: a "Search note contents" button (visible whenever `bodyScan ===
  "idle"`). Tapping it starts the scan, flips to `"scanning"`, and streams
  `BodyMatch` rows into a second results section with a progress line ("42 of
  310 notes scanned") and a Cancel action.
- Body-match rows resolve `uri` → note title via the already-loaded `index`
  (no extra read needed — `index.notes.find(n => n.uri === uri)`) for the
  card header, with the `snippet` shown as the excerpt line instead of the
  note's stored excerpt. Reuses `NoteCard` (same visual grammar as index
  results) — new prop or an `excerptOverride`-style param, whichever fits
  `NoteCard`'s existing prop shape (check at implementation time).
- Tapping a body-match row: same `resolveNoteEntry` → `navigation.navigate("RecentDetail", …)` path as index results.
- Starting a new scan (query change while `bodyScan === "scanning"`) aborts
  the in-flight one and resets `bodyMatches`/`bodyScan` to idle — a query
  edit implicitly cancels, not just the explicit Cancel button.
- Unmounting the screen (navigate away) aborts any in-flight scan (cleanup in
  the effect/callback holding the `AbortController`).

### Testing

New `apps/mobile/src/lib/vault.test.ts` (this file currently has none —
`SearchScreen`/`vault.ts` logic is presently untested per CLAUDE.md's
screen-coverage note), mirroring `writer.test.ts`'s `expo-file-system/legacy`
mock pattern:

- Finds a body match that Phase 1 index search would miss (match beyond the
  200-char excerpt window).
- Streams incrementally: `onMatch` fires per match as reads resolve, not only
  once at the end (assert call ordering/timing via a controlled mock, not
  wall-clock).
- Respects cancellation: abort after N of M reads have started; assert no
  further `readNote` calls after abort, and the returned `{ scanned, total }`
  reflects the partial state.
- Skips unreadable notes without failing the whole scan (one `readNote`
  rejects, scan continues, `scanned` still increments appropriately).

`SearchScreen.test.tsx` (if a screen-level test exists/is added) covers the
button appearing only with a non-empty query, the progress line updating, and
cancel-on-query-change — but per CLAUDE.md, screens currently have zero
coverage; a full screen test isn't required to land this feature (existing
project norm), the `vault.ts` unit coverage above is the primary gate.

## Non-goals (explicit, from the PRD)

- No body cache — SAF read cost is paid per explicit request each time.
- No automatic trigger — always an explicit user action, never fired on
  every keystroke.
- No new library dependency (flexsearch/minisearch/etc.) — plain JS
  substring matching, consistent with Phase 1's approach and the vault's
  realistic size (hundreds to low thousands of notes, per the PRD's math).
- No change to Phase 1 index ranking, tag index, or TagBrowser.
- Phase 3 (retrospective query) stays out of scope — still gated on S4.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Large vault (1000+ notes) makes a full-text scan slow | Low-Medium | Same exposure the existing index rebuild already has at concurrency 8; streaming results + visible progress means the user sees value immediately rather than waiting for completion; cancellable |
| Cancellation leaves a dangling in-flight read | Low | SAF/file:// have no cancel primitive — in-flight reads finish and are simply not added to results after `signal.aborted` is observed; no leaked promise rejection since `mapWithConcurrency`'s `await fn(item)` still resolves normally |
| Snippet extraction on a huge single-line note (e.g. no newlines) | Low | Window is char-based (~40 each side), not line-based — bounded regardless of line structure |

## Open decisions (resolved during brainstorming, 2026-07-19)

- Trigger UX: button below index results, not an always-visible mode toggle.
- Result display: matched snippet shown (not bare title/metadata).
- Cancellation: yes, cancellable mid-scan.
