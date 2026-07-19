# Search Phase 2 (on-demand full-text search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, on-demand "Search note contents" action to the Search screen that streams case-insensitive substring matches from note bodies (not just the indexed title/tags/excerpt), with live progress and cancellation.

**Architecture:** A new `searchNoteBodies` function in `apps/mobile/src/lib/vault.ts`, sharing the existing `listNoteFiles`/`readNote`/`mapWithConcurrency` primitives that `buildNoteIndex` already uses, streams `{ uri, snippet }` matches via callback as each note resolves. `SearchScreen.tsx` triggers it from a button, renders results as they arrive using the existing `NoteCard` component, and shows/cancels via an `AbortController`.

**Tech Stack:** TypeScript, React Native, Expo, vitest, `@testing-library/react` (jsdom) for the screen test.

## Global Constraints

- No SQLite (repo-wide constraint, `CLAUDE.md`) — everything stays on the existing `readNote`/AsyncStorage primitives already used by `vault.ts`.
- No new dependency (per the spec's non-goals) — plain JS substring matching.
- No automatic trigger — the scan only starts on explicit user action (button tap), never on keystroke.
- No body cache — every "Search note contents" tap re-reads the vault.
- `tsc --noEmit`, `npm -w @carnet/mobile run lint`, and `npm -w @carnet/mobile test` must all pass before each commit (this repo's standing CI gate).

---

## File Structure

- **Modify:** `apps/mobile/src/lib/vault.ts` — add `mapWithConcurrency` cancellation support (internal), `BodyMatch` type, `searchNoteBodies` function.
- **Modify:** `apps/mobile/src/lib/vaultSearch.test.ts` — new `describe("searchNoteBodies")` block, following this file's existing `./writer` mock pattern (do NOT add a new `vault.test.ts` — this is the existing test file for `vault.ts`'s search-facing exports).
- **Modify:** `apps/mobile/src/screens/SearchScreen.tsx` — new state (`bodyMatches`, `bodyScan`, `bodyScanProgress`, an `AbortController` ref), a body-search footer section wired into the existing `FlatList` via `ListFooterComponent`.
- **Modify:** `apps/mobile/src/screens/SearchScreen.test.tsx` — extend the existing `../lib/vault` mock with `searchNoteBodies`, add cases for the button, streaming results, and cancel-on-query-change.

No new files. Both touched library/screen files stay under this repo's size norms after these additions (`vault.ts` is ~480 lines today; the addition is ~40 lines).

---

### Task 1: `searchNoteBodies` in `vault.ts`

**Files:**
- Modify: `apps/mobile/src/lib/vault.ts:91-107` (`mapWithConcurrency`), and add new code after `resolveNoteEntry` (currently ends at line 476).
- Test: `apps/mobile/src/lib/vaultSearch.test.ts` (existing file — append a new `describe` block)

**Interfaces:**
- Consumes: `listNoteFiles(): Promise<NoteFileRef[]>` and `readNote(filepath: string): Promise<string>` from `./writer` (already imported in `vault.ts:28`); `stripFrontmatter` from `./frontmatter` (already imported in `vault.ts:26`); the existing `mapWithConcurrency<T>` and `SCAN_CONCURRENCY` (`vault.ts:42,92`).
- Produces: `export interface BodyMatch { uri: string; snippet: string }` and `export async function searchNoteBodies(query: string, onMatch: (match: BodyMatch) => void, onProgress: (progress: { scanned: number; total: number }) => void, signal: AbortSignal): Promise<{ scanned: number; total: number }>` — Task 2 (`SearchScreen.tsx`) imports and calls this directly.

- [ ] **Step 1: Write the failing tests**

Open `apps/mobile/src/lib/vaultSearch.test.ts`. Add `searchNoteBodies` and `type BodyMatch` to the existing import block from `./vault` (around line 41-54):

```ts
import {
  buildNoteIndex,
  getNoteIndex,
  getTagIndex,
  invalidateNoteIndex,
  loadCachedNoteIndex,
  loadCachedTagIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNoteBodies,
  searchNotes,
  upsertNoteInIndex,
  type BodyMatch,
  type NoteIndex,
  type NoteIndexEntry,
} from "./vault";
import { listNoteFiles, readNote } from "./writer";
```

(`readNote` isn't currently imported at the top level of this test file outside the mock — add it so tests can call `vi.mocked(readNote).mockImplementation(...)`.)

Append this block at the end of the file:

```ts
// ── searchNoteBodies ─────────────────────────────────────────────────────────

describe("searchNoteBodies", () => {
  it("finds a match beyond the indexed excerpt window (200 chars)", async () => {
    const long = "x".repeat(250) + " findme here";
    addNote("file:///v/Ideas/deep.md", "Ideas", `---\n---\n# T\n\n${long}\n`);

    const matches: BodyMatch[] = [];
    const result = await searchNoteBodies(
      "findme",
      (m) => matches.push(m),
      () => {},
      new AbortController().signal,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].uri).toBe("file:///v/Ideas/deep.md");
    expect(matches[0].snippet).toContain("findme");
    expect(result).toEqual({ scanned: 1, total: 1 });
  });

  it("matches case-insensitively", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# T\n\nHello WORLD\n");

    const matches: BodyMatch[] = [];
    await searchNoteBodies("world", (m) => matches.push(m), () => {}, new AbortController().signal);

    expect(matches).toHaveLength(1);
  });

  it("skips unreadable notes without failing the whole scan", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\n---\n# T\n\nneedle good\n");
    _listRefs.push({ uri: "file:///v/Ideas/bad.md", name: "bad.md", subdir: "Ideas" });
    _unreadable.add("file:///v/Ideas/bad.md");

    const matches: BodyMatch[] = [];
    const result = await searchNoteBodies(
      "needle",
      (m) => matches.push(m),
      () => {},
      new AbortController().signal,
    );

    expect(matches).toEqual([
      { uri: "file:///v/Ideas/ok.md", snippet: expect.stringContaining("needle") },
    ]);
    expect(result).toEqual({ scanned: 2, total: 2 });
  });

  it("reports incremental progress via onProgress as each note is scanned", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# T\n\nneedle a\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\n---\n# T\n\nneedle b\n");

    const progressCalls: Array<{ scanned: number; total: number }> = [];
    await searchNoteBodies(
      "needle",
      () => {},
      (p) => progressCalls.push(p),
      new AbortController().signal,
    );

    expect(progressCalls).toEqual([
      { scanned: 1, total: 2 },
      { scanned: 2, total: 2 },
    ]);
  });

  it("delivers a fast match before a concurrently-scanning slow note resolves", async () => {
    addNote("file:///v/Ideas/fast.md", "Ideas", "---\n---\n# T\n\nneedle fast\n");
    addNote("file:///v/Ideas/slow.md", "Ideas", "---\n---\n# T\n\nneedle slow\n");

    let resolveSlow!: (v: string) => void;
    const slowPromise = new Promise<string>((res) => {
      resolveSlow = res;
    });

    vi.mocked(readNote)
      .mockImplementationOnce(async () => _notes.get("file:///v/Ideas/fast.md")!)
      .mockImplementationOnce(() => slowPromise);

    const matches: string[] = [];
    const done = searchNoteBodies(
      "needle",
      (m) => matches.push(m.uri),
      () => {},
      new AbortController().signal,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(matches).toEqual(["file:///v/Ideas/fast.md"]);

    resolveSlow("---\n---\n# T\n\nneedle slow\n");
    await done;
    expect(matches).toEqual(["file:///v/Ideas/fast.md", "file:///v/Ideas/slow.md"]);
  });

  it("stops issuing new reads once aborted, keeping only already-issued results", async () => {
    const uris = Array.from({ length: 9 }, (_, i) => `file:///v/Ideas/n${i}.md`);
    for (const uri of uris) addNote(uri, "Ideas", "---\n---\n# T\n\nneedle here\n");

    const resolvers: Array<() => void> = [];
    const calledUris: string[] = [];
    vi.mocked(readNote).mockImplementation((uri: string) => {
      calledUris.push(uri);
      return new Promise<string>((res) => resolvers.push(() => res(_notes.get(uri)!)));
    });

    const controller = new AbortController();
    const matches: string[] = [];
    const done = searchNoteBodies(
      "needle",
      (m) => matches.push(m.uri),
      () => {},
      controller.signal,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(calledUris).toHaveLength(8); // SCAN_CONCURRENCY — item 9 (index 8) is queued, not issued

    controller.abort();
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(calledUris).toHaveLength(8); // no 9th read issued after abort

    resolvers.slice(1).forEach((r) => r());
    const result = await done;
    expect(result).toEqual({ scanned: 8, total: 9 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w @carnet/mobile test -- vaultSearch.test.ts`
Expected: FAIL — `searchNoteBodies is not a function` / `does not provide an export named 'searchNoteBodies'`.

- [ ] **Step 3: Implement `mapWithConcurrency` cancellation support**

In `apps/mobile/src/lib/vault.ts`, replace the existing `mapWithConcurrency` (lines 91-107):

```ts
/** Run `fn` over `items` with at most `limit` in flight at once. When `signal`
 * aborts, no NEW items are started (already-issued `fn` calls are allowed to
 * finish — there's no read-cancel primitive for file:// or SAF). */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}
```

This is purely additive (`signal` is optional, defaults to `undefined`) — `buildNoteIndex` (`vault.ts:158`) and `notesForTag` (`vault.ts:396`) don't pass it, so their behavior is unchanged.

- [ ] **Step 4: Implement `searchNoteBodies`**

Add this after `resolveNoteEntry` (end of `apps/mobile/src/lib/vault.ts`, currently line 476):

```ts
// ── On-demand full-text body search (Phase 2) ─────────────────────────────────

/** ~40 chars of context on each side of the match, in the snippet shown to
 * the user — bounded regardless of the note's line structure (char-based,
 * not line-based). */
const SNIPPET_WINDOW = 40;

/** One body-search hit: the note URI and a short window of body text around
 * the first match, for display without opening the note. */
export interface BodyMatch {
  uri: string;
  snippet: string;
}

/** Extract a snippet around the first case-insensitive match of `query` in
 * `strippedBody`, or null when there's no match. */
function extractSnippet(strippedBody: string, query: string): string | null {
  const idx = strippedBody.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_WINDOW);
  const end = Math.min(strippedBody.length, idx + query.length + SNIPPET_WINDOW);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < strippedBody.length ? "…" : "";
  return prefix + strippedBody.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * Stream on-demand body matches for `query` across every vault note — the
 * Phase 2 "Search note contents" escape hatch for a match Phase 1's indexed
 * title/tags/excerpt search misses (a hit deeper in the body than the
 * ~200-char excerpt window). Case-insensitive substring match against the
 * frontmatter-stripped body. `onMatch` fires immediately per hit (streaming,
 * not collected into an array) and `onProgress` fires after every note is
 * processed (match or not) so a caller can render a live "N of M" indicator.
 * Checks `signal.aborted` before starting each note's read — already-issued
 * reads are allowed to finish, but no new ones start after cancellation.
 * Unreadable notes (deleted mid-scan, permission revoked) are skipped,
 * matching `buildNoteIndex`'s behavior. Callers must guard against an empty
 * query — it trivially matches every note's body.
 */
export async function searchNoteBodies(
  query: string,
  onMatch: (match: BodyMatch) => void,
  onProgress: (progress: { scanned: number; total: number }) => void,
  signal: AbortSignal,
): Promise<{ scanned: number; total: number }> {
  const files = await listNoteFiles();
  const total = files.length;
  let scanned = 0;

  await mapWithConcurrency(
    files,
    SCAN_CONCURRENCY,
    async (file) => {
      let markdown: string | null = null;
      try {
        markdown = await readNote(file.uri);
      } catch {
        // unreadable — still counts as scanned, no match
      }
      scanned += 1;
      if (markdown !== null) {
        const snippet = extractSnippet(stripFrontmatter(markdown), query);
        if (snippet !== null) onMatch({ uri: file.uri, snippet });
      }
      onProgress({ scanned, total });
    },
    signal,
  );

  return { scanned, total };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w @carnet/mobile test -- vaultSearch.test.ts`
Expected: PASS (all existing `vaultSearch.test.ts` cases plus the new `searchNoteBodies` block).

- [ ] **Step 6: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS (tsc clean, lint clean, full suite green — confirms the `mapWithConcurrency` signature change didn't break `buildNoteIndex`/`notesForTag`'s existing tests).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/vault.ts apps/mobile/src/lib/vaultSearch.test.ts
git commit -m "feat(search): searchNoteBodies — cancellable streaming full-text scan"
```

---

### Task 2: Wire body search into `SearchScreen.tsx`

**Files:**
- Modify: `apps/mobile/src/screens/SearchScreen.tsx`
- Test: `apps/mobile/src/screens/SearchScreen.test.tsx`

**Interfaces:**
- Consumes: `searchNoteBodies(query, onMatch, onProgress, signal): Promise<{ scanned, total }>` and `type BodyMatch = { uri: string; snippet: string }` from `../lib/vault` (Task 1). `NoteCard` (`../components/NoteCard`) — already imported in this file, accepts `excerpt?: string` generically (no `NoteCard` changes needed).
- Produces: nothing new consumed elsewhere — this is the UI leaf.

- [ ] **Step 1: Write the failing tests**

Open `apps/mobile/src/screens/SearchScreen.test.tsx`. Extend the `../lib/vault` mock (lines 46-59) to add `searchNoteBodies`:

```ts
vi.mock("../lib/vault", () => ({
  getNoteIndex: vi.fn(async () => ({ builtAt: 1, notes: NOTES })),
  refreshNoteIndex: vi.fn(async () => ({ builtAt: 2, notes: NOTES })),
  searchNotes: vi.fn((index: { notes: NoteIndexEntry[] }) => index.notes),
  searchNoteBodies: vi.fn(),
  resolveNoteEntry: vi.fn(async (uri: string) => ({
    id: "resolved-1",
    mode: "idea",
    title: "First idea",
    filepath: uri,
    createdAt: 1_700_000_000_000,
  })),
}));
```

Update the import line below it (currently `import { resolveNoteEntry } from "../lib/vault";`) to also pull `searchNoteBodies`:

```ts
import { resolveNoteEntry, searchNoteBodies } from "../lib/vault";
```

Append these test cases at the end of the file (inside a new `describe("body search", ...)` block, using this file's existing `renderScreen` helper and `beforeEach(() => vi.clearAllMocks())`):

```ts
describe("body search", () => {
  it("shows the 'Search note contents' button only once a query is typed", () => {
    renderScreen();
    expect(screen.queryByText("Search note contents")).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText("Search notes"), "hello");
    expect(screen.getByText("Search note contents")).toBeTruthy();
  });

  it("streams body matches as they resolve and shows a progress line", async () => {
    let onMatchCb!: (m: { uri: string; snippet: string }) => void;
    let onProgressCb!: (p: { scanned: number; total: number }) => void;
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, onMatch, onProgress, _signal) =>
        new Promise((resolve) => {
          onMatchCb = onMatch;
          onProgressCb = onProgress;
          // Deliberately never auto-resolves — the test drives it manually.
          void resolve;
        }),
    );

    renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText("Search notes"), "hello");
    fireEvent.press(screen.getByText("Search note contents"));

    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalled());

    onProgressCb({ scanned: 1, total: 2 });
    onMatchCb({ uri: "file:///v/Journal/2026-07-08.md", snippet: "…matched text…" });

    await waitFor(() => expect(screen.getByText(/1 of 2 notes/)).toBeTruthy());
    expect(screen.getByText("…matched text…")).toBeTruthy();
  });

  it("cancels the in-flight scan when the query changes", () => {
    const abortSpy = vi.fn();
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, _onMatch, _onProgress, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", abortSpy);
        }),
    );

    renderScreen();
    fireEvent.changeText(screen.getByPlaceholderText("Search notes"), "hello");
    fireEvent.press(screen.getByText("Search note contents"));
    fireEvent.changeText(screen.getByPlaceholderText("Search notes"), "hello world");

    expect(abortSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w @carnet/mobile test -- SearchScreen.test.tsx`
Expected: FAIL — "Search note contents" text not found (button doesn't exist yet).

- [ ] **Step 3: Implement the screen changes**

In `apps/mobile/src/screens/SearchScreen.tsx`:

Update the import from `"../lib/vault"` (lines 20-27) to add `searchNoteBodies` and `type BodyMatch`:

```ts
import {
  getNoteIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNoteBodies,
  searchNotes,
  type BodyMatch,
  type NoteIndex,
  type NoteIndexEntry,
} from "../lib/vault";
```

Add `useRef` to the React import (line 12):

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

After the existing state declarations (after line 54, `const [filtersOpen, setFiltersOpen] = useState(false);`), add:

```ts
  // Phase 2: on-demand full-text body search, explicit-trigger only. Reset
  // (and cancel any in-flight scan) whenever the query changes — a query
  // edit implicitly invalidates whatever was being scanned for the old one.
  const [bodyMatches, setBodyMatches] = useState<BodyMatch[]>([]);
  const [bodyScan, setBodyScan] = useState<"idle" | "scanning" | "done" | "cancelled">(
    "idle",
  );
  const [bodyScanProgress, setBodyScanProgress] = useState<{ scanned: number; total: number }>({
    scanned: 0,
    total: 0,
  });
  const bodyScanController = useRef<AbortController | null>(null);

  useEffect(() => {
    setBodyMatches([]);
    setBodyScan("idle");
    setBodyScanProgress({ scanned: 0, total: 0 });
    return () => {
      bodyScanController.current?.abort();
    };
  }, [query]);

  const startBodySearch = useCallback(() => {
    const controller = new AbortController();
    bodyScanController.current = controller;
    setBodyMatches([]);
    setBodyScan("scanning");
    setBodyScanProgress({ scanned: 0, total: 0 });
    void searchNoteBodies(
      query,
      (match) => setBodyMatches((prev) => [...prev, match]),
      (progress) => setBodyScanProgress(progress),
      controller.signal,
    ).then((finalProgress) => {
      setBodyScanProgress(finalProgress);
      setBodyScan(controller.signal.aborted ? "cancelled" : "done");
    });
  }, [query]);

  const cancelBodySearch = useCallback(() => {
    bodyScanController.current?.abort();
  }, []);
```

After `hasActiveFilters` (line 128) and before `renderItem` (line 130), add a helper to resolve a matched URI back to its index metadata, and the footer JSX builder:

```ts
  const noteForUri = useCallback(
    (uri: string) => index?.notes.find((n) => n.uri === uri),
    [index],
  );

  const bodySearchFooter = query.trim() ? (
    <View
      style={{
        gap: theme.carnet.spacing.md,
        paddingTop: theme.carnet.spacing.md,
        paddingHorizontal: theme.carnet.spacing.md,
        paddingBottom: theme.carnet.spacing.xl,
      }}
    >
      {bodyScan === "idle" && (
        <Pressable
          onPress={startBodySearch}
          style={styles.pillHit}
          accessibilityRole="button"
          accessibilityLabel="Search note contents"
        >
          <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
            Search note contents
          </Text>
        </Pressable>
      )}
      {bodyScan === "scanning" && (
        <View style={{ gap: theme.carnet.spacing.sm }}>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {`Scanning… ${bodyScanProgress.scanned} of ${bodyScanProgress.total} notes`}
          </Text>
          <Pressable
            onPress={cancelBodySearch}
            style={styles.pillHit}
            accessibilityRole="button"
            accessibilityLabel="Cancel note content search"
          >
            <Text variant="labelLarge" style={{ color: theme.colors.error }}>
              Cancel
            </Text>
          </Pressable>
        </View>
      )}
      {(bodyScan === "done" || bodyScan === "cancelled") && (
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {bodyScan === "cancelled"
            ? `Cancelled — ${bodyScanProgress.scanned} of ${bodyScanProgress.total} notes scanned`
            : `Scanned ${bodyScanProgress.total} notes`}
        </Text>
      )}
      {bodyMatches.map((match) => {
        const meta = noteForUri(match.uri);
        return (
          <NoteCard
            key={match.uri}
            title={meta?.title ?? match.uri}
            mode={meta?.mode ?? "idea"}
            excerpt={match.snippet}
            tags={meta?.tags}
            onPress={() => void openNote(match.uri)}
          />
        );
      })}
    </View>
  ) : null;
```

Finally, wire `bodySearchFooter` into the existing `FlatList` (around line 255) by adding a `ListFooterComponent` prop:

```tsx
        <FlatList
          data={results}
          keyExtractor={(item) => item.uri}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            results.length === 0 ? styles.center : null,
            {
              paddingHorizontal: theme.carnet.spacing.md,
              paddingBottom: theme.carnet.spacing.xl,
              gap: theme.carnet.spacing.md,
            },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListFooterComponent={bodySearchFooter}
          ListEmptyComponent={
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {query.trim() || hasActiveFilters
                ? "Nothing matches — try fewer filters or different words."
                : "No notes yet — capture something first."}
            </Text>
          }
        />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w @carnet/mobile test -- SearchScreen.test.tsx`
Expected: PASS (all existing cases plus the new `body search` describe block).

- [ ] **Step 5: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS.

- [ ] **Step 6: Manual on-device smoke check (per this repo's `docs/smoke-test.md` pattern)**

On the connected device (or emulator): open Search, type a query that only matches deep in a note's body (not its title/tags/first-200-chars), confirm it's absent from the instant index results, tap "Search note contents", confirm it streams in with a progress line, tap the result to confirm it opens `RecentDetail`. Then repeat and tap Cancel mid-scan on a vault with enough notes for the scan to take visible time — confirm partial results stay and the progress line reflects "Cancelled — N of M". This step is exploratory (not automatable in this repo's harness) — note the outcome in the commit message or a follow-up comment, don't block the commit on it if the automated gate above is green.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/screens/SearchScreen.tsx apps/mobile/src/screens/SearchScreen.test.tsx
git commit -m "feat(search): wire on-demand body search into Search screen"
```

---

## Self-Review Notes (fixed inline before handoff)

- **Spec coverage:** Both spec sections (`vault.ts` streaming function, `SearchScreen.tsx` UX) have a task. The spec's `NoteCard` "check at implementation time" ambiguity is resolved: `NoteCard` already accepts a generic `excerpt?: string` prop, so no `NoteCard` changes are needed — Task 2 confirms this directly.
- **Test file naming:** The spec draft assumed a new `vault.test.ts`; corrected after reading the actual repo — `vault.ts` is already tested by `vaultSearch.test.ts`, and `SearchScreen.tsx` already has `SearchScreen.test.tsx` with an established mock pattern. Both tasks extend the real existing files, not new ones.
- **Interface refinement:** The spec's sketch signature was `searchNoteBodies(query, onMatch, signal)`. Task 1 adds an `onProgress` callback — needed for the spec's own requirement of a live "N of M notes scanned" line in `SearchScreen`, which a single final return value can't drive. This is a signature detail, not an architecture change.
- **Type consistency:** `BodyMatch` (`{ uri: string; snippet: string }`) is defined once in Task 1 and imported as a type in both Task 1's test file and Task 2's screen file — no divergent redefinition.
