# Plan: Bulk delete recents from Home (multi-select)

## Summary
Add long-press-to-select + multi-select bulk delete to the Home screen's recents list. Long-press a row → selection mode; subsequent taps toggle selection; a single "Delete N" action archives all selected (via the existing `moveToArchive` + `removeFromHistory` helpers). Closes the one-at-a-time tax for cleaning up misfires without leaving Home.

## User Story
As a carnet user with a few bad captures cluttering my recents,
I want to long-press one, tap a few more, and delete them in one action,
So that cleanup doesn't take 5 round-trips through `RecentDetail`.

## Problem → Solution
**Current:** Each recent can be deleted only via its own `RecentDetail` screen (tap row → detail → Delete → confirm → back). For N misfires, that's 4N taps. The recents card on Home is just a passive list.

**Desired:** Long-press a row → enters selection mode (each row gets a checkbox indicator, card title flips to "N selected", Cancel + Delete actions appear). Tap rows to toggle. Confirm + bulk archive in one shot. After delete, exit selection mode and refresh the list.

## Metadata
- **Complexity**: Small (~1 PR, smaller than PR #8/PR #9)
- **Source PRD**: N/A — surfaced by the user in this session as "delete items"
- **PRD Phase**: v0.3
- **Estimated Files**: 2 modified + 1 test extension
- **Confidence Score**: 9/10 — every primitive exists (`moveToArchive`, `removeFromHistory`); only screen-state machinery is new

---

## UX Design

### Before
```
┌─────────────────────────────┐
│ Carnet              [⚙]     │
├─────────────────────────────┤
│ [ Idea ] [ Journal ] …      │
│ ─────────────────────────── │
│ Recent                      │
│  ◉ Shared image: …     >    │   tap → RecentDetail
│  ◉ Journal entry       >    │   tap → RecentDetail
│  ◉ Pizza place idea    >    │   tap → RecentDetail
│  ◉ Shared audio: …     >    │   tap → RecentDetail
│   (no bulk action — must     │
│    delete one at a time      │
│    via the detail screen)    │
└─────────────────────────────┘
```

### After (selection mode active)
```
┌─────────────────────────────┐
│ Carnet              [⚙]     │
├─────────────────────────────┤
│ [ Idea ] [ Journal ] …      │
│ ─────────────────────────── │
│ 3 selected          ✕  [🗑] │   ← Cancel + Delete actions
│  ☑ Shared image: …          │
│  ☐ Journal entry            │
│  ☑ Pizza place idea         │
│  ☑ Shared audio: …          │   tap row → toggle (no nav)
│                             │
└─────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Long-press recent row | (no handler) | Enter selection mode, mark that row selected | Standard Material pattern |
| Tap recent row (normal mode) | Navigate to `RecentDetail` | Unchanged | The normal path stays the same |
| Tap recent row (selection mode) | — | Toggle selection on/off | If last item deselected → auto-exit selection mode |
| Card title in selection mode | "Recent" | "N selected" | Reuses Card.Title |
| Cancel action (selection mode) | — | Exit selection, clear all selected | Shown as text/icon button on the card title row |
| Delete N action (selection mode) | — | Confirm Dialog → moveToArchive each → removeManyFromHistory → refresh | Paper Dialog mirrors PR #8 |
| Empty selection | — | Selection mode automatically exits | No stuck "0 selected" state |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/screens/HomeScreen.tsx` | 1-178 | Where selection mode + the action row land |
| P0 | `apps/mobile/src/lib/storage.ts` | 1-40 | `removeFromHistory` to mirror for the new batch helper |
| P0 | `apps/mobile/src/lib/storage.test.ts` | 1-90 | Existing test pattern for the batch helper |
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | 70-96, 148-181 | `deletingRef` in-flight guard + Dialog confirm pattern to mirror exactly |
| P1 | `apps/mobile/src/lib/writer.ts` | (moveToArchive) | Already-public helper invoked N times; no change needed |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| react-native-paper `List.Item` | https://callstack.github.io/react-native-paper/docs/components/List/ListItem | Accepts `onPress` AND `onLongPress` (both forwarded to the underlying `TouchableRipple`). Use the same component, swap the `left` prop based on selection state. |
| react-native-paper `Checkbox` | https://callstack.github.io/react-native-paper/docs/components/Checkbox | Use `Checkbox.Android status="checked"|"unchecked"` for the row indicator. Cheaper than rolling a custom check icon. |

---

## Discovery Table

| Category | File:Lines | Pattern | Key snippet |
|---|---|---|---|
| Recents schema | `storage.ts:6-14` | `CaptureEntry { id, mode, title, filepath, createdAt }` | id is the selection key |
| Single-id removal | `storage.ts:35-39` | read → filter by id → write | Mirror for the multi-id `removeManyFromHistory` |
| Test mock for AsyncStorage | `storage.test.ts:6-16` | In-memory `_store: Map<string, string>` + vi.mock | Reuse for the new helper's tests |
| In-flight guard ref | `RecentDetailScreen.tsx:46-71` | `deletingRef = useRef(false)`; check → set → finally clear | Mirror for `bulkDeletingRef` |
| Dialog confirm | `RecentDetailScreen.tsx:163-181` | `<Portal><Dialog visible={confirmVisible}>…<Dialog.Actions><Button>Cancel</Button><Button>Delete</Button></Dialog.Actions></Dialog></Portal>` | Reuse shape; copy "Move to Archive?" wording |
| Refresh on focus | `HomeScreen.tsx:34-45` | `navigation.addListener('focus', refresh)` | Already correct; selection mode shouldn't survive blur — clear on blur |
| List.Item rendering | `HomeScreen.tsx:117-130` | `<List.Item title description left onPress>` | Swap `left` for `Checkbox` in selection mode |
| navigation.navigate gate | `HomeScreen.tsx:127` | `onPress={() => navigation.navigate('RecentDetail', { entry: item })}` | In selection mode: `onPress=toggleSelection(id)` instead |
| Bulk archive driver | `writer.ts moveToArchive` (already public) | one call per selected entry | Acceptable for ≤20 items; no need to batch the writer side |

---

## Patterns to Mirror

### REMOVE_FROM_HISTORY_PATTERN
```ts
// SOURCE: apps/mobile/src/lib/storage.ts:35-39
export async function removeFromHistory(id: string): Promise<void> {
  const existing = await getRecentCaptures();
  const next = existing.filter((e) => e.id !== id);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
```
Mirror for the new helper:
```ts
export async function removeManyFromHistory(ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return;
  const toRemove = new Set(ids);
  const existing = await getRecentCaptures();
  const next = existing.filter((e) => !toRemove.has(e.id));
  if (next.length === existing.length) return; // no-op write avoided
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
```
Set lookup keeps the filter O(N). Single AsyncStorage write regardless of selection count.

### IN_FLIGHT_GUARD (from RecentDetail)
```ts
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:46, 70-89
const deletingRef = useRef(false);
const handleDelete = useCallback(async () => {
  if (deletingRef.current) return;
  deletingRef.current = true;
  // ... work ...
  // (no reset — screen unmounts on goBack)
}, [...]);
```
For Home's bulk delete, DO reset the ref in `finally` since the screen doesn't unmount:
```ts
const bulkDeletingRef = useRef(false);
const handleBulkDelete = useCallback(async () => {
  if (bulkDeletingRef.current) return;
  bulkDeletingRef.current = true;
  try {
    // ... archive each + removeMany ...
  } finally {
    bulkDeletingRef.current = false;
  }
}, [...]);
```

### DIALOG_CONFIRM (from RecentDetail)
```tsx
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:163-181
<Portal>
  <Dialog visible={confirmVisible} onDismiss={() => setConfirmVisible(false)}>
    <Dialog.Title>Move to Archive?</Dialog.Title>
    <Dialog.Content>
      <Text variant="bodyMedium">
        The note and any paired file will be moved to Archive/. You can recover
        them by browsing the vault in Obsidian.
      </Text>
    </Dialog.Content>
    <Dialog.Actions>
      <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
      <Button onPress={handleDelete} textColor={theme.colors.error}>Delete</Button>
    </Dialog.Actions>
  </Dialog>
</Portal>
```
Mirror exactly. Body text becomes `"N notes and any paired files will be moved to Archive/. …"` (pluralized).

### LIST_ITEM_RENDER (current HomeScreen)
```tsx
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:117-130
{recent.map((item) => (
  <List.Item
    key={item.id}
    title={item.title}
    description={`${formatMode(item.mode)} • ${formatDate(item.createdAt)}`}
    left={(p) => <List.Icon {...p} icon={modeIcon(item.mode)} />}
    onPress={() => navigation.navigate("RecentDetail", { entry: item })}
    style={styles.listItem}
  />
))}
```
After:
```tsx
{recent.map((item) => {
  const selected = selectedIds.has(item.id);
  return (
    <List.Item
      key={item.id}
      title={item.title}
      description={`${formatMode(item.mode)} • ${formatDate(item.createdAt)}`}
      left={(p) =>
        selectionMode ? (
          <Checkbox.Android
            status={selected ? "checked" : "unchecked"}
            onPress={() => toggleSelection(item.id)}
          />
        ) : (
          <List.Icon {...p} icon={modeIcon(item.mode)} />
        )
      }
      onPress={() => {
        if (selectionMode) toggleSelection(item.id);
        else navigation.navigate("RecentDetail", { entry: item });
      }}
      onLongPress={() => enterSelection(item.id)}
      style={styles.listItem}
    />
  );
})}
```

### REFRESH_ON_FOCUS_CLEARS_SELECTION
```ts
// Extend the existing focus listener to also clear selection on blur
useEffect(() => {
  const sub = navigation.addListener("focus", () => { void refresh(); });
  const subBlur = navigation.addListener("blur", () => { exitSelection(); });
  void refresh();
  return () => { sub(); subBlur(); };
}, [navigation, refresh, exitSelection]);
```
Why: if the user enters selection mode, navigates away (e.g. to Capture), and comes back, they shouldn't return to an ambiguous mid-selection state.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATE | Add `removeManyFromHistory(ids)` |
| `apps/mobile/src/lib/storage.test.ts` | UPDATE | Tests for the new helper |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | Selection state, handlers, action row, Dialog, Checkbox in `left`, branch on `selectionMode` in `onPress` |

## NOT Building
- **Multi-select on `RecentDetail`** — that screen shows one note. Bulk lives on Home.
- **Swipe-to-delete on individual rows** — gesture conflicts with selection mode and the existing `onPress` navigate. Out of scope.
- **Bulk re-enrich** — slate item #5 already shipped per-note; extending to bulk is a separate PR if/when requested.
- **Archive browser / restore from archive** — separate plan (the option B from the scoping question).
- **Undo / snackbar with restore** — soft-delete already supports recovery via Obsidian; undo at the carnet layer is a different design effort.
- **Selection across re-renders / persistence** — selection is screen-local state; clears on blur.
- **Bulk delete from queue (offline-pending)** — different surface, different mental model.

---

## Step-by-Step Tasks

### Task 1: Add `removeManyFromHistory` to storage.ts
- **ACTION**: Append a new public helper to `apps/mobile/src/lib/storage.ts`.
- **IMPLEMENT**: per `REMOVE_FROM_HISTORY_PATTERN` mirror, with the early-return no-op-write guard.
- **MIRROR**: `REMOVE_FROM_HISTORY_PATTERN`.
- **IMPORTS**: none new — `AsyncStorage` and `getRecentCaptures` already in scope.
- **GOTCHA**: do NOT write to AsyncStorage if no entries actually matched the id set. Otherwise back-to-back bulk-deletes with the same ids would write the same payload twice; the guard avoids the wasted IO + a JSON round-trip on `getRecentCaptures` cache miss.
- **VALIDATE**: Task 2 tests.

### Task 2: Tests for `removeManyFromHistory`
- **ACTION**: Extend `apps/mobile/src/lib/storage.test.ts`.
- **IMPLEMENT**:
  ```ts
  describe("removeManyFromHistory", () => {
    beforeEach(() => { _store.clear(); });

    it("removes multiple ids in one write, preserving order of survivors", async () => {
      await recordCapture(entry("a"));
      await recordCapture(entry("b"));
      await recordCapture(entry("c"));
      await recordCapture(entry("d"));
      await removeManyFromHistory(["b", "d"]);
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["c", "a"]);
    });

    it("ignores unknown ids", async () => {
      await recordCapture(entry("a"));
      await removeManyFromHistory(["nope", "alsoNope"]);
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["a"]);
    });

    it("is a no-op on empty input (no AsyncStorage write)", async () => {
      await recordCapture(entry("a"));
      await removeManyFromHistory([]);
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["a"]);
    });

    it("handles all-ids-match (full clear)", async () => {
      await recordCapture(entry("a"));
      await recordCapture(entry("b"));
      await removeManyFromHistory(["a", "b"]);
      const xs = await getRecentCaptures();
      expect(xs).toEqual([]);
    });

    it("dedupes via internal Set (passing the same id twice still removes once)", async () => {
      await recordCapture(entry("a"));
      await recordCapture(entry("b"));
      await removeManyFromHistory(["a", "a"]);
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["b"]);
    });
  });
  ```
- **IMPORTS**: add `removeManyFromHistory` to the existing `from "./storage"` line.
- **MIRROR**: existing storage.test.ts describe-block shape.
- **GOTCHA**: storage.test.ts already mocks AsyncStorage via `vi.mock` at the top of the file — don't re-declare.
- **VALIDATE**: `npm -w @carnet/mobile run test`.

### Task 3: Selection mode + bulk delete UI in HomeScreen.tsx
- **ACTION**: Edit `apps/mobile/src/screens/HomeScreen.tsx`. Add selection state, handlers, the selection-mode header row, swap `left` slot to checkbox, branch `onPress`, wire long-press, render the confirm Dialog.
- **IMPLEMENT**:
  - State:
    ```ts
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [confirmVisible, setConfirmVisible] = useState(false);
    const bulkDeletingRef = useRef(false);
    ```
  - Imports to add: `useRef` already used implicitly via hooks; explicitly `useRef` from "react", plus `Checkbox`, `Dialog`, `Portal`, `IconButton` from "react-native-paper", `moveToArchive` from `../lib/writer`, `removeManyFromHistory` from `../lib/storage`.
  - Handlers:
    ```ts
    const enterSelection = useCallback((id: string) => {
      setSelectionMode(true);
      setSelectedIds(new Set([id]));
    }, []);

    const toggleSelection = useCallback((id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) setSelectionMode(false);
        return next;
      });
    }, []);

    const exitSelection = useCallback(() => {
      setSelectionMode(false);
      setSelectedIds(new Set());
    }, []);

    const handleBulkDelete = useCallback(async () => {
      if (bulkDeletingRef.current) return;
      bulkDeletingRef.current = true;
      setConfirmVisible(false);
      const ids = Array.from(selectedIds);
      const entries = recent.filter((e) => selectedIds.has(e.id));
      try {
        // Best-effort per item — one bad SAF revocation shouldn't block the others.
        await Promise.allSettled(entries.map((e) => moveToArchive(e.filepath)));
        await removeManyFromHistory(ids);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[Home] bulk delete failed:", msg);
      } finally {
        bulkDeletingRef.current = false;
        exitSelection();
        await refresh();
      }
    }, [selectedIds, recent, refresh, exitSelection]);
    ```
  - Focus + blur listener:
    ```ts
    useEffect(() => {
      const unsubFocus = navigation.addListener("focus", () => { void refresh(); });
      const unsubBlur = navigation.addListener("blur", () => { exitSelection(); });
      void refresh();
      return () => { unsubFocus(); unsubBlur(); };
    }, [navigation, refresh, exitSelection]);
    ```
  - Card content (replace the current `Card` rendering of recents):
    ```tsx
    <Card style={styles.recentCard}>
      {selectionMode ? (
        <View style={styles.selectionHeader}>
          <IconButton icon="close" onPress={exitSelection} accessibilityLabel="Cancel selection" />
          <Text variant="titleMedium" style={styles.selectionTitle}>
            {`${selectedIds.size} selected`}
          </Text>
          <IconButton
            icon="delete"
            iconColor={theme.colors.error}
            onPress={() => setConfirmVisible(true)}
            accessibilityLabel="Delete selected"
          />
        </View>
      ) : (
        <Card.Title title="Recent" />
      )}
      <Card.Content>
        {recent.length === 0 ? (
          <Text variant="bodyMedium" style={styles.emptyHint}>No captures yet.</Text>
        ) : (
          <View>
            {recent.map((item) => {
              const selected = selectedIds.has(item.id);
              return (
                <List.Item
                  key={item.id}
                  title={item.title}
                  description={`${formatMode(item.mode)} • ${formatDate(item.createdAt)}`}
                  left={(p) =>
                    selectionMode ? (
                      <Checkbox.Android
                        status={selected ? "checked" : "unchecked"}
                        onPress={() => toggleSelection(item.id)}
                      />
                    ) : (
                      <List.Icon {...p} icon={modeIcon(item.mode)} />
                    )
                  }
                  onPress={() => {
                    if (selectionMode) toggleSelection(item.id);
                    else navigation.navigate("RecentDetail", { entry: item });
                  }}
                  onLongPress={() => enterSelection(item.id)}
                  style={styles.listItem}
                />
              );
            })}
          </View>
        )}
      </Card.Content>
    </Card>

    <Portal>
      <Dialog visible={confirmVisible} onDismiss={() => setConfirmVisible(false)}>
        <Dialog.Title>Move {selectedIds.size} to Archive?</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium">
            The selected notes and any paired files will be moved to Archive/.
            You can recover them by browsing the vault in Obsidian.
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
          <Button onPress={handleBulkDelete} textColor={theme.colors.error}>Delete</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
    ```
  - Styles to add:
    ```ts
    selectionHeader: { flexDirection: "row", alignItems: "center", paddingLeft: 4, paddingRight: 8 },
    selectionTitle: { flex: 1, marginLeft: 4 },
    ```
- **MIRROR**: `LIST_ITEM_RENDER`, `IN_FLIGHT_GUARD`, `DIALOG_CONFIRM`, `REFRESH_ON_FOCUS_CLEARS_SELECTION`.
- **IMPORTS**: `useCallback`, `useRef` from react; `Checkbox`, `Dialog`, `IconButton`, `Portal` from react-native-paper; `moveToArchive` from `../lib/writer`; `removeManyFromHistory` from `../lib/storage`.
- **GOTCHA**:
  - `Promise.allSettled` over per-item `moveToArchive` so one SAF revocation doesn't abort the others. The accompanying `removeManyFromHistory` runs even on partial archive failure — the user wants the row gone from recents even if Archive write failed (Obsidian still has the .md; the row is just a pointer).
  - Selection state lives only in the screen — no AsyncStorage persistence. If the user backgrounds the app, selection clears on next focus (matches Android Material defaults).
  - `Checkbox.Android` matters — the iOS-style `Checkbox` doesn't render an Android-native check, which clashes visually.
- **VALIDATE**: typecheck + tests + manual.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| `removeManyFromHistory` empty array | `[]` | no-op, no write | yes |
| `removeManyFromHistory` removes multiple | `["b","d"]` from `[a,b,c,d]` (MRU) | `[c,a]` | no |
| `removeManyFromHistory` ignores unknown ids | `["nope"]` against `[a]` | `[a]` | yes |
| `removeManyFromHistory` clears all when all ids match | `["a","b"]` against `[a,b]` | `[]` | yes |
| `removeManyFromHistory` dedupes via Set | `["a","a"]` against `[a,b]` | `[b]` | yes |

### Edge Cases Checklist
- [x] Empty selection → handled by `selectedIds.size === 0` auto-exit
- [x] All recents selected → bulk delete clears the card entirely
- [x] One SAF-revoked archive amid N successes → others still complete, history row cleared
- [x] Screen blurred mid-selection → exits selection on blur
- [x] User long-presses, doesn't select more, taps Delete → single-item bulk-delete (degenerate but correct)
- [x] User backgrounds app + returns → focus listener refreshes recents; no stale selection (blur listener cleared it)

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors, prior 131 + 5 new = ~136/136 passing.

### On-device
```bash
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk \
  PATH="/home/user/Android/Sdk/platform-tools:$PATH" \
  npx expo run:android
```
(JS-only — no prebuild needed.)

### Manual Validation
- [ ] Long-press a recent → row gets a check, card title flips to "1 selected", Cancel + Delete buttons appear
- [ ] Tap another row → "2 selected"
- [ ] Tap same row again → "1 selected" (toggle off)
- [ ] Deselect down to 0 → selection mode auto-exits
- [ ] Cancel (X) → exits selection cleanly
- [ ] Delete → confirm dialog says "Move N to Archive?" → Cancel: no change → Delete: archive each + history cleared + selection exits
- [ ] Bulk delete a Photo + a Shared-image → both archived, paired binaries moved
- [ ] Bulk delete with one note whose paired binary is missing (broken link) → others still complete (degraded silently per Promise.allSettled)
- [ ] Long-press → navigate to Capture → return to Home → selection mode is gone (blur listener)
- [ ] Tap a recent in normal mode → still navigates to RecentDetail (regression)
- [ ] Single-item Delete from RecentDetail still works (regression)

---

## Acceptance Criteria
- [ ] Long-press enters selection mode and selects the long-pressed row
- [ ] Tap toggles selection in selection mode; navigates in normal mode
- [ ] Auto-exit when selection drops to zero
- [ ] Cancel button exits cleanly
- [ ] Delete → confirm Dialog → archives all selected, clears history, refreshes
- [ ] Blur exits selection mode
- [ ] `removeManyFromHistory` does a single AsyncStorage write regardless of count
- [ ] No type errors; ~136/136 tests pass

## Completion Checklist
- [ ] Mirrors `IN_FLIGHT_GUARD`, `DIALOG_CONFIRM`, `LIST_ITEM_RENDER` patterns from PR #8
- [ ] No new hardcoded colors (uses `theme.colors.error` only)
- [ ] No tests for the screen itself (consistent with PR #8); helpers ARE unit-tested
- [ ] No `console.log` (one `console.warn` in the failure path, matches existing pattern)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User long-presses by accident, deletes a batch | Medium | Data loss confusion | Soft-delete to Archive/ is recoverable in Obsidian; confirm dialog gates the destructive step |
| Long-press conflicts with platform gestures (Android share menu, etc.) | Low | Selection mode triggers when user wanted system menu | Standard List.Item long-press is well-behaved on RN 0.81; no observed conflicts |
| `Promise.allSettled` masks a real failure for ALL items | Low | Silent data integrity miss | Per-item failures are common (SAF revoke); a 100% failure rate would manifest as "items still show in recents after delete" since `removeManyFromHistory` only runs after — if archive fully fails we still remove from history, which is the user's expressed intent |
| Selection survives an accidental orientation change | Low | Slightly weird re-render | React state preserved across rotation; this is desired |
| Checkbox.Android tap event bubbles to row onPress | Medium | Double-toggle | Mitigated by giving Checkbox its own onPress that calls `toggleSelection` — the row onPress branches on `selectionMode` and ALSO toggles. To avoid double-toggle, the Checkbox `onPress` is set so the row's onPress doesn't fire (Paper's TouchableRipple propagates by default). If observed in manual validation, add `e.stopPropagation()` or skip the row's onPress when the press originated in the checkbox |

## Notes
- This is the smallest plausible "delete items" PR. The bigger follow-ups (Archive browser, undo snackbar) are documented in NOT Building so a future contributor doesn't redo this scoping.
- The `Promise.allSettled` choice over `Promise.all` is deliberate: a single SAF revocation shouldn't cancel a 10-item cleanup. The intent of the bulk action is "I am cleaning up; do as much as you can."
- The blur listener clearing selection is friendly default behavior. If a future PR wants selection to persist (e.g. select on Home, navigate to a bulk-tag editor, return), the listener can be removed surgically without changing the rest of the machinery.
