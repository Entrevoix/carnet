# Plan: Recents browse + preview + delete (Axis C foundation)

## Summary
Make the recent-captures list tappable, add a read-only preview screen that renders the saved markdown, and a soft-delete affordance that moves both the .md and any paired binary to an `Archive/` subdir. Foundation for slate items #5 (retro-enrich any past capture) and #6 (inline edit) — both build on this surface. Walks "intake-only" back the minimum amount: read + delete only, no edit yet.

## User Story
As a carnet user,
I want to tap a recent capture to see exactly what was saved and to delete a bad capture without leaving the app,
So that I can trust the intake pipeline at-a-glance instead of opening Obsidian on desktop, and so I can clean up misfires (OCR mangled a contact, accidental share, wrong photo) immediately.

## Problem → Solution
**Current:** `HomeScreen` displays the last 5 captures as `List.Item`s — title, mode, date, icon — but they're not tappable. The only way to verify what carnet saved is to open Obsidian on a desktop. The only way to delete a bad capture is to navigate the vault folder in a file manager.

**Desired:** Tap a recent → opens a `RecentDetail` screen with the rendered markdown body, the paired binary (if any), and metadata. A Delete button moves the .md (and paired binary) to `Archive/`, removes the entry from recents, and bounces back to Home. Recents grows to 20 (was 5) so users have more than a tap-window of history.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A — slate item #1 from `.claude/PRPs/plans/audio-and-arbitrary-file-share-types.plan.md`-era market research (see PR #7 conversation)
- **PRD Phase**: v0.3
- **Estimated Files**: 5 modified + 2 new
- **Confidence Score**: 8/10 (well-established patterns; markdown-renderer choice is the only material unknown)

---

## UX Design

### Before
```
┌─────────────────────────────┐
│ Carnet              [⚙]     │
├─────────────────────────────┤
│ [ Idea ]                    │
│ [ Journal ]                 │
│ [ Contact ]                 │
│ [ Photo ]                   │
│  Continue today's journal   │
│ ─────────────────────────── │
│ Recent                      │
│  ◉ Shared audio: …  (today) │  ← display-only
│  ◉ Journal entry    (today) │  ← display-only
│  ◉ Pizza place idea (yest)  │  ← display-only
└─────────────────────────────┘
```

### After
```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ Carnet              [⚙]     │    │ Shared audio: meeting.m4a   │
├─────────────────────────────┤    ├─────────────────────────────┤
│ [ Idea ]                    │    │ ◉ Shared audio · 5 min ago  │
│ [ Journal ]                 │    │ Audio/meeting.m4a           │
│ [ Contact ]                 │    │                             │
│ [ Photo ]                   │    │ # Shared audio: meeting.m4a │
│  Continue today's journal   │    │                             │
│ ─────────────────────────── │    │ ## File                     │
│ Recent                      │    │ [meeting.m4a](../Audio/…)   │
│  ◉ Shared audio: …    >     │ →  │                             │
│  ◉ Journal entry      >     │    │ ## Context                  │
│  ◉ Pizza place idea   >     │    │ (none provided)             │
│  (up to 20 tappable rows)   │    │                             │
└─────────────────────────────┘    │ [🗑 Delete]                 │
                                    └─────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Recent row | Display-only `List.Item` | Tappable → `RecentDetail` | Wrap with `onPress` |
| RecentDetail (new) | — | Title, mode chip, timestamp, file path (copyable), rendered markdown, Delete | Bottom-of-screen action card like ShareReceive's saved phase |
| Delete tap | — | Confirm dialog → `moveToArchive` → `removeFromHistory` → `navigation.goBack()` | Soft-delete; never `unlink` until v0.4+ |
| Recent capacity | 5 | 20 | Plain list, no pagination |
| Missing-file case | — | Banner: "edited/deleted outside carnet" + Remove-from-recents button | Common case: user opened Obsidian and renamed/deleted the .md |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/storage.ts` | 1-33 | Recents schema + the LIMIT constant we're bumping; mirror pattern for `removeFromHistory` |
| P0 | `apps/mobile/src/screens/HomeScreen.tsx` | 1-178 | Where the recents card lives; the `List.Item` rows we're making tappable |
| P0 | `apps/mobile/src/lib/writer.ts` | 141-190, 373-385, 557-585 | `findOrCreateSubdir`, `findCollisionFreeName`, `stripFrontmatter` (currently private), `writeBinary` (the binary-write reference) |
| P0 | `apps/mobile/App.tsx` | 21-27, 93-126 | `RootStackParamList` + `Stack.Screen` registration pattern |
| P1 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | 104-129, 495-540 | `savingRef` in-flight guard pattern; saved-phase Card+Banner+Actions layout |
| P1 | `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | 290-326 | Alternate Banner block formatting (multi-line `<Banner>` is more readable than the inline form) |
| P1 | `apps/mobile/src/screens/CaptureScreen.tsx` | 290-310 | `readNote` + `updateNote` usage example |
| P2 | `apps/mobile/src/lib/writer.test.ts` | 1-90 | Vitest mock pattern for `expo-file-system/legacy` and the in-memory `_files` store |
| P2 | `apps/mobile/src/lib/shareHelpers.test.ts` | 1-100 | Recently-landed pattern for new pure-helper files + co-located tests |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| react-native-markdown-display | https://github.com/iamacup/react-native-markdown-display | Pure JS (no native module → no prebuild). Themeable via `style` prop keyed by element (`text`, `heading1`, `code_block`, etc.). Active fork by @ronradtke if upstream is stale. |
| react-native-paper Dialog | https://callstack.github.io/react-native-paper/docs/components/Dialog | Used for the delete confirm. Already in the dep tree (we use Paper everywhere). |

---

## Discovery Table (codebase intelligence captured here so implementation doesn't need to re-search)

| Category | File:Lines | Pattern | Key snippet |
|---|---|---|---|
| Recents schema | `storage.ts:6-14` | Plain TS interface, mode literal-union | `interface CaptureEntry { id, mode, title, filepath, createdAt }` |
| Recents write | `storage.ts:29-33` | Read → unshift → slice → JSON.stringify → AsyncStorage.setItem | `const next = [entry, ...existing].slice(0, HISTORY_LIMIT);` |
| Nav param shape | `App.tsx:21-27` | Object map: `ScreenName: ParamsOrUndefined` | `Capture: { mode: CaptureMode };` |
| Nav typed call | `HomeScreen.tsx:55, 65, 85` | `navigation.navigate("ScreenName", params)` — params inferred from `NativeStackScreenProps` | `navigation.navigate("Capture", { mode: "idea" })` |
| Refresh-on-focus | `HomeScreen.tsx:39-45` | `navigation.addListener("focus", refresh)` + immediate first call | Used unchanged after delete returns user to Home |
| In-flight guard | `ShareReceiveScreen.tsx:108, 126-129` | `savingRef = useRef(false)` + check + set + finally-clear | Mirror for delete-in-flight |
| Banner inline | `ShareReceiveScreen.tsx:511-513` | `<Banner visible icon="alert" actions={[]}>` one-liner | Quick alert (degraded/error) |
| Banner block | `PhotoCaptureScreen.tsx:295-303` | Multi-line block, more readable | Prefer this style for the missing-file banner |
| Saved card layout | `ShareReceiveScreen.tsx:506-538` | Card + Card.Title + Card.Content + Card.Actions | Mirror for the action area on RecentDetail |
| Note read | `CaptureScreen.tsx:300` | `const existing = await readNote(filepath)` | Same call in RecentDetail mount |
| Frontmatter strip | `writer.ts:373-379` | `function stripFrontmatter(...)` — currently NOT exported | Need to promote to `export` |
| Subdir create | `writer.ts:176-190` | `findOrCreateSubdir(root, "Archive")` returns URI | Reuse for archive path |
| Collision-bumped name | `writer.ts:141-157` | `findCollisionFreeName(parentUri, stem, ext, isSaf)` | Reuse so archive doesn't overwrite earlier archived copies |
| Binary write | `writer.ts:557-585` | `writeBinary("Photos", ...)` SAF vs file:// branching | Mirror inverse for binary delete: SAF vs file:// |
| Test mock pattern | `writer.test.ts:25-67` | `vi.mock("expo-file-system/legacy", ...)` with in-memory `_files` Map | Add `deleteAsync` to the mock |

---

## Patterns to Mirror

Each pattern below is captured verbatim from the codebase. Mirror the shape — do not reinvent.

### CAPTURE_ENTRY_INTERFACE
```ts
// SOURCE: apps/mobile/src/lib/storage.ts:6-14
export type CaptureMode = "idea" | "journal" | "person" | "photo";

export interface CaptureEntry {
  id: string;
  mode: CaptureMode;
  title: string;
  filepath: string;
  createdAt: number;
}
```
Unchanged. `RecentDetail`'s nav param uses this type directly.

### HISTORY_WRITE_PATTERN
```ts
// SOURCE: apps/mobile/src/lib/storage.ts:29-33 (recordCapture)
export async function recordCapture(entry: CaptureEntry): Promise<void> {
  const existing = await getRecentCaptures();
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
```
Mirror for `removeFromHistory`: read → filter → write. Same lock-free pattern; no need for a serialize() wrapper because recents are user-driven (no concurrent drains).

### NAV_PARAM_REGISTRATION
```ts
// SOURCE: apps/mobile/App.tsx:21-27
export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
  PhotoCapture: undefined;
};
```
Add `RecentDetail: { entry: CaptureEntry }`. Imports `CaptureEntry` from `./src/lib/storage`.

### STACK_SCREEN_REGISTRATION
```ts
// SOURCE: apps/mobile/App.tsx:111-115
<Stack.Screen
  name="Settings"
  component={SettingsScreen}
  options={{ title: "Settings" }}
/>
```
Mirror with dynamic title from route params (like the `Capture` screen on lines 99-110).

### TYPED_NAV_NAVIGATE
```ts
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:55, 65, 85
onPress={() => navigation.navigate("Capture", { mode: "idea" })}
onPress={() => navigation.navigate("Capture", { mode: "journal" })}
onPress={() => navigation.navigate("PhotoCapture")}
```
Mirror: `onPress={() => navigation.navigate("RecentDetail", { entry: item })}`.

### REFRESH_ON_FOCUS
```ts
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:34-45
const refresh = useCallback(async () => {
  const items = await getRecentCaptures();
  setRecent(items);
}, []);

useEffect(() => {
  const unsubscribe = navigation.addListener("focus", () => {
    void refresh();
  });
  void refresh();
  return unsubscribe;
}, [navigation, refresh]);
```
Already present; unchanged. After RecentDetail's delete pops back, focus fires → recents refresh automatically.

### IN_FLIGHT_GUARD
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx:104-129
const savingRef = useRef(false);
// ...
const save = async () => {
  if (savingRef.current) return;
  savingRef.current = true;
  // ... work ...
  } finally {
    savingRef.current = false;
  }
};
```
Mirror for the delete handler — prevents fast-double-tap from running `moveToArchive` twice.

### CARD_ACTIONS_LAYOUT
```tsx
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx:506-538
<Card style={styles.card}>
  <Card.Title title="Saved to vault" />
  <Card.Content>
    {degradedReason ? (
      <Banner visible icon="alert" actions={[]} style={styles.degradedBanner}>
        {`AI enrichment failed — saved as a stub note. ${degradedReason}`}
      </Banner>
    ) : null}
    <Text variant="bodySmall" selectable style={styles.body}>
      {savedFilepath ?? "(no path)"}
    </Text>
  </Card.Content>
  <Card.Actions>
    {degradedReason ? (
      <Button mode="text" onPress={reEnrichSaved}>Re-enrich</Button>
    ) : null}
    <Button mode="contained" onPress={() => navigation.goBack()}>Done</Button>
  </Card.Actions>
</Card>
```
Mirror for RecentDetail's action card. Replace "Done" with "Delete" (icon=delete, textColor=error). Add a confirmation `Dialog` before invoking the delete handler.

### MISSING_FILE_BANNER
```tsx
// SOURCE: apps/mobile/src/screens/PhotoCaptureScreen.tsx:295-303 (block form)
<Banner
  visible
  icon="alert"
  actions={[]}
  style={styles.degradedBanner}
>
  {`AI enrichment failed — saved as a stub. ${degradedReason}`}
</Banner>
```
Mirror for the "edited/deleted outside carnet" banner. Pass `actions={[{ label: "Remove from recents", onPress: handleRemoveFromHistory }]}`.

### READ_NOTE_USAGE
```ts
// SOURCE: apps/mobile/src/screens/CaptureScreen.tsx:300-302
const existing = await readNote(savedFilepath);
const patched = rewriteFrontmatterField(existing, "status", next);
await updateNote(savedFilepath, patched);
```
For RecentDetail's mount, just the read half:
```ts
try {
  const content = await readNote(entry.filepath);
  setBody(content);
} catch {
  setMissing(true);
}
```

### TEST_STRUCTURE
```ts
// SOURCE: apps/mobile/src/lib/writer.test.ts:1-67 (vi.mock + in-memory store)
const _files: Map<string, FileEntry> = new Map();

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  getInfoAsync: vi.fn(async (uri: string) => ({ exists: _files.has(uri), uri, isDirectory: false })),
  // ...
  readAsStringAsync: vi.fn(async (uri: string) => {
    const entry = _files.get(uri);
    if (!entry) throw new Error(`File not found: ${uri}`);
    return entry.content;
  }),
  writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
    _files.set(uri, { content });
  }),
  // ...
}));
```
Mirror: add `deleteAsync: vi.fn(async (uri: string) => { _files.delete(uri); })` to the mock so `moveToArchive` tests can verify the source is removed.

### PURE_HELPER_FILE_PATTERN
```ts
// SOURCE: apps/mobile/src/lib/shareHelpers.ts + .test.ts (landed in PR #7)
// 1. Pure helpers in shareHelpers.ts
// 2. Co-located <name>.test.ts with `import { … } from "./shareHelpers"`
// 3. Header comment summarizing "three concerns" or similar
```
No new pure-helper file needed for THIS plan — `removeFromHistory` lives next to `recordCapture` in `storage.ts`, and `moveToArchive` lives in `writer.ts`.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATE | Bump `HISTORY_LIMIT` to 20; add `removeFromHistory` |
| `apps/mobile/src/lib/storage.test.ts` | CREATE | Tests for the new helper + the existing functions |
| `apps/mobile/src/lib/writer.ts` | UPDATE | Add `moveToArchive`; promote `stripFrontmatter` to exported |
| `apps/mobile/src/lib/writer.test.ts` | UPDATE | `moveToArchive` cases (with/without paired binary, SAF + file://) |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | Wrap `List.Item`s in `onPress` |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | CREATE | New detail/preview/delete screen (~150-200 lines) |
| `apps/mobile/App.tsx` | UPDATE | Register `RecentDetail` in `RootStackParamList` + `Stack.Navigator` |
| `apps/mobile/package.json` | UPDATE | Add `react-native-markdown-display` |
| `apps/mobile/package-lock.json` | UPDATE | (auto) |

## NOT Building
- **Inline edit** — slate item #6, separate PR. Read-only this round.
- **Retro-enrich button on detail** — slate item #5, separate PR; builds onto this plan's foundation.
- **Browse-by-kind tabs (Ideas/Journal/People/Photos)** — separate, deferred.
- **Full-text or semantic vault search** — separate, deferred; depends on a vault index spike.
- **Pagination past 20 recents** — defer until user signal demands it.
- **Hard delete (FileSystem.deleteAsync without archiving)** — soft-delete only; users can `rm -rf Archive/` themselves.
- **Multi-select / bulk operations** — defer.
- **Star/pin recents** — defer.
- **Edit YAML frontmatter (tags, kind)** — pairs with inline edit; defer.

---

## Step-by-Step Tasks

### Task 1: Bump HISTORY_LIMIT + add removeFromHistory
- **ACTION**: Edit `apps/mobile/src/lib/storage.ts`.
- **IMPLEMENT**:
  ```ts
  const HISTORY_LIMIT = 20;  // was 5
  
  export async function removeFromHistory(id: string): Promise<void> {
    const existing = await getRecentCaptures();
    const next = existing.filter((e) => e.id !== id);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }
  ```
- **MIRROR**: `HISTORY_WRITE_PATTERN`.
- **IMPORTS**: None new — `AsyncStorage` already imported.
- **GOTCHA**: No migration needed — `getRecentCaptures` already handles arbitrary array lengths.
- **VALIDATE**: Unit test (Task 7) and Task 5's manual flow.

### Task 2: Add moveToArchive helper to writer.ts
- **ACTION**: Append a new public function `moveToArchive(filepath)` to `apps/mobile/src/lib/writer.ts`. Also change `stripFrontmatter` from `function` to `export function` (Task 6 needs it from outside the file).
- **IMPLEMENT**: 
  ```ts
  /**
   * Soft-delete a note: copy the .md (and any paired binary referenced via a
   * relative `../{Subdir}/{name}.{ext}` link in the body) to Archive/, then
   * remove the originals. Subdir-aware: Photos/, Audio/, Files/ are scanned.
   *
   * Returns the archived .md path and the archived binary path (or null when
   * no paired binary was found or the link target didn't exist).
   */
  export async function moveToArchive(
    filepath: string,
  ): Promise<{ archivedMdPath: string; archivedBinaryPath: string | null }> {
    const root = await resolveRoot();
    const archiveUri = await findOrCreateSubdir(root, "Archive");
  
    // 1. Read source markdown
    const content = await readByUri(filepath);
  
    // 2. Detect paired binary via relative link in body
    //    Match `../{Photos|Audio|Files}/{name}.{ext}` permissively.
    const linkMatch = content.match(
      /\.\.\/(Photos|Audio|Files)\/([^\s)]+)/,
    );
    let pairedBinaryUri: string | null = null;
    let pairedSubdir: string | null = null;
    let pairedFilename: string | null = null;
    if (linkMatch) {
      pairedSubdir = linkMatch[1];
      pairedFilename = linkMatch[2];
      const subdirUri = await findOrCreateSubdir(root, pairedSubdir);
      pairedBinaryUri = await findFileInDir(subdirUri, pairedFilename, root.isSaf);
    }
  
    // 3. Derive archive filenames (collision-bumped per subdir)
    const mdName = filepath.split("/").pop() ?? "note.md";
    const mdStem = mdName.replace(/\.[^.]+$/, "");
    const mdArchiveName = await findCollisionFreeName(archiveUri, mdStem, ".md", root.isSaf);
  
    // 4. Write archive copies
    const archivedMdPath = await writeNewFile(archiveUri, mdArchiveName, content, root.isSaf);
  
    let archivedBinaryPath: string | null = null;
    if (pairedBinaryUri && pairedFilename) {
      const binStem = pairedFilename.replace(/\.[^.]+$/, "");
      const binExt = pairedFilename.slice(binStem.length); // includes the leading "."
      const binArchiveName = await findCollisionFreeName(archiveUri, binStem, binExt, root.isSaf);
      const binBase64 = await readBinaryByUri(pairedBinaryUri, root.isSaf);
      archivedBinaryPath = await writeBinaryBytes(archiveUri, binArchiveName, binBase64, root.isSaf);
    }
  
    // 5. Delete originals (best-effort — SAF revocation can fail)
    try { await deleteByUri(filepath, root.isSaf); } catch { /* leave the original */ }
    if (pairedBinaryUri) {
      try { await deleteByUri(pairedBinaryUri, root.isSaf); } catch { /* leave the original */ }
    }
  
    return { archivedMdPath, archivedBinaryPath };
  }
  ```
  Plus three small private helpers next to `readByUri`/`writeByUri`:
  ```ts
  async function readBinaryByUri(uri: string, isSaf: boolean): Promise<string> {
    if (isSaf) {
      return StorageAccessFramework.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    }
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  }
  async function writeBinaryBytes(
    parentUri: string, filename: string, base64: string, isSaf: boolean,
  ): Promise<string> {
    if (isSaf) {
      const fileUri = await StorageAccessFramework.createFileAsync(parentUri, filename, "application/octet-stream");
      await StorageAccessFramework.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
      return fileUri;
    }
    const fileUri = `${parentUri.replace(/\/$/, "")}/${filename}`;
    await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
    return fileUri;
  }
  async function deleteByUri(uri: string, isSaf: boolean): Promise<void> {
    if (isSaf) {
      await StorageAccessFramework.deleteAsync(uri);
      return;
    }
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
  ```
  And promote stripFrontmatter:
  ```ts
  - function stripFrontmatter(markdown: string): string {
  + export function stripFrontmatter(markdown: string): string {
  ```
- **MIRROR**: `findOrCreateSubdir`, `findCollisionFreeName`, `findFileInDir`, `writeBinary` (all already in `writer.ts`).
- **IMPORTS**: `StorageAccessFramework` and `FileSystem` already imported at top of file.
- **GOTCHA**:
  - SAF + file:// branches need DIFFERENT delete APIs — `deleteByUri` helper handles this.
  - If the paired binary in the body doesn't exist (broken link from prior edit), `findFileInDir` returns null and we silently archive just the .md. Don't fail.
  - Base64 round-trip preserves bytes; never UTF-8-encode binary.
  - `{ idempotent: true }` on `FileSystem.deleteAsync` so a retry doesn't crash.
- **VALIDATE**: Task 7 unit tests; Task 9 manual.

### Task 3: Install react-native-markdown-display
- **ACTION**: `npm -w @carnet/mobile install react-native-markdown-display`.
- **IMPLEMENT**: Add the dep. Pure JS, no native module → no prebuild step required.
- **MIRROR**: How other libs land in `package.json` (no special config).
- **IMPORTS**: N/A.
- **GOTCHA**:
  - On RN 0.81 the upstream package emits a peer dep warning. Accept it; if it actually breaks, swap to `@ronradtke/react-native-markdown-display` (active fork). Don't pin a workaround in this PR.
  - Default `style` doesn't theme well in dark mode — pass `style={{ body: { color: theme.colors.onSurface } }}`.
- **VALIDATE**: `npm -w @carnet/mobile run typecheck` clean; Metro picks up the dep without restart.

### Task 4: Create RecentDetailScreen.tsx
- **ACTION**: Create `apps/mobile/src/screens/RecentDetailScreen.tsx` (~150-200 lines).
- **IMPLEMENT**:
  ```tsx
  // High-level shape (annotated for clarity):
  import { useEffect, useState, useRef, useCallback } from "react";
  import { ScrollView, StyleSheet, View } from "react-native";
  import { ActivityIndicator, Banner, Button, Card, Chip, Dialog, Portal, Text, useTheme } from "react-native-paper";
  import Markdown from "react-native-markdown-display";
  import type { NativeStackScreenProps } from "@react-navigation/native-stack";
  
  import type { RootStackParamList } from "../../App";
  import { readNote, moveToArchive, stripFrontmatter } from "../lib/writer";
  import { removeFromHistory, type CaptureEntry } from "../lib/storage";
  
  type Props = NativeStackScreenProps<RootStackParamList, "RecentDetail">;
  
  export default function RecentDetailScreen({ route, navigation }: Props) {
    const theme = useTheme();
    const { entry } = route.params;
  
    const [body, setBody] = useState<string>("");
    const [missing, setMissing] = useState(false);
    const [loading, setLoading] = useState(true);
    const [confirmVisible, setConfirmVisible] = useState(false);
    const deletingRef = useRef(false);  // MIRROR: IN_FLIGHT_GUARD
  
    // Mount: read the note (or mark missing)
    useEffect(() => {
      let mounted = true;
      (async () => {
        try {
          const content = await readNote(entry.filepath);
          if (!mounted) return;
          setBody(content);
        } catch {
          if (!mounted) return;
          setMissing(true);
        } finally {
          if (mounted) setLoading(false);
        }
      })();
      return () => { mounted = false; };
    }, [entry.filepath]);
  
    const handleDelete = useCallback(async () => {
      if (deletingRef.current) return;
      deletingRef.current = true;
      setConfirmVisible(false);
      try {
        await moveToArchive(entry.filepath);
      } catch (e: unknown) {
        // Best-effort: even if archive failed, drop from history so the
        // user isn't stuck staring at a ghost recent.
        console.warn("[RecentDetail] archive failed:", e instanceof Error ? e.message : String(e));
      }
      try {
        await removeFromHistory(entry.id);
      } catch (e: unknown) {
        console.warn("[RecentDetail] removeFromHistory failed:", e instanceof Error ? e.message : String(e));
      }
      navigation.goBack();
    }, [entry.filepath, entry.id, navigation]);
  
    const handleRemoveFromHistory = useCallback(async () => {
      if (deletingRef.current) return;
      deletingRef.current = true;
      await removeFromHistory(entry.id);
      navigation.goBack();
    }, [entry.id, navigation]);
  
    if (loading) {
      return <View style={styles.loading}><ActivityIndicator /></View>;
    }
  
    // body has frontmatter — strip it for the renderer; show the cleaned version.
    const renderBody = stripFrontmatter(body);
  
    return (
      <>
        <ScrollView contentContainerStyle={styles.content}>
          {missing ? (
            <Banner visible icon="alert" actions={[{ label: "Remove from recents", onPress: handleRemoveFromHistory }]}>
              This note was edited or deleted outside carnet.
            </Banner>
          ) : null}
  
          {/* Header card: metadata */}
          <Card style={styles.card}>
            <Card.Title title={entry.title} subtitle={`${formatMode(entry.mode)} · ${formatDate(entry.createdAt)}`} />
            <Card.Content>
              <Text variant="bodySmall" selectable style={styles.path}>
                {entry.filepath}
              </Text>
            </Card.Content>
          </Card>
  
          {/* Body card: rendered markdown */}
          {!missing ? (
            <Card style={styles.card}>
              <Card.Content>
                <Markdown style={markdownStyle(theme)}>{renderBody}</Markdown>
              </Card.Content>
            </Card>
          ) : null}
  
          {/* Action card: Delete */}
          <Card style={styles.card}>
            <Card.Actions>
              <Button
                mode="text"
                icon="delete"
                textColor={theme.colors.error}
                onPress={() => setConfirmVisible(true)}
                disabled={missing}
              >
                Delete
              </Button>
            </Card.Actions>
          </Card>
        </ScrollView>
  
        <Portal>
          <Dialog visible={confirmVisible} onDismiss={() => setConfirmVisible(false)}>
            <Dialog.Title>Move to Archive?</Dialog.Title>
            <Dialog.Content>
              <Text variant="bodyMedium">
                The note and any paired file will be moved to {`Archive/`}. You can recover them by browsing the vault in Obsidian.
              </Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
              <Button onPress={handleDelete} textColor={theme.colors.error}>Delete</Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      </>
    );
  }
  
  // Local presentation helpers (mirror HomeScreen's formatMode/formatDate)
  function formatMode(mode: CaptureEntry["mode"]): string {
    switch (mode) {
      case "idea": return "Idea";
      case "journal": return "Journal";
      case "person": return "Contact";
      case "photo": return "Photo";
    }
  }
  function formatDate(unix: number): string {
    return new Date(unix).toLocaleString();
  }
  function markdownStyle(theme: ReturnType<typeof useTheme>) {
    return {
      body: { color: theme.colors.onSurface, fontSize: 15, lineHeight: 22 },
      heading1: { color: theme.colors.onSurface, fontWeight: "700" as const, marginTop: 12 },
      heading2: { color: theme.colors.onSurface, fontWeight: "600" as const, marginTop: 10 },
      code_inline: { backgroundColor: theme.colors.surfaceVariant, color: theme.colors.onSurfaceVariant, padding: 2, borderRadius: 4 },
      code_block: { backgroundColor: theme.colors.surfaceVariant, color: theme.colors.onSurfaceVariant, padding: 8, borderRadius: 6 },
      link: { color: theme.colors.primary },
    };
  }
  
  const styles = StyleSheet.create({
    content: { padding: 16, gap: 12 },
    card: { marginTop: 4 },
    path: { opacity: 0.6 },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  });
  ```
- **MIRROR**: `CARD_ACTIONS_LAYOUT` for the action card; `MISSING_FILE_BANNER` for the missing-file path; `READ_NOTE_USAGE` for the mount fetch; `IN_FLIGHT_GUARD` for `deletingRef`.
- **IMPORTS**: shown inline above.
- **GOTCHA**:
  - `<Portal>` requires `PaperProvider` ancestor — already wraps the app at `App.tsx:90`.
  - `react-native-markdown-display` may crash on Android when an emoji is in the markdown if a custom font is set; the `markdownStyle` above intentionally omits `fontFamily` to use the platform default.
  - Don't block render on the read; show ActivityIndicator while `loading=true`.
  - `mounted` flag prevents `setState` after unmount if the user backs out fast.
- **VALIDATE**: Task 9 manual flow + Task 8 (no unit test for the screen itself; the helpers it calls ARE unit-tested).

### Task 5: Register RecentDetail in App.tsx + make Home recents tappable
- **ACTION**: Edit `apps/mobile/App.tsx` and `apps/mobile/src/screens/HomeScreen.tsx`.
- **IMPLEMENT**:
  ```ts
  // App.tsx — add to imports
  import RecentDetailScreen from "./src/screens/RecentDetailScreen";
  import type { CaptureMode, CaptureEntry } from "./src/lib/storage";
  
  // App.tsx — extend the param list
  export type RootStackParamList = {
    Home: undefined;
    Capture: { mode: CaptureMode };
    Settings: undefined;
    ShareReceive: undefined;
    PhotoCapture: undefined;
    RecentDetail: { entry: CaptureEntry };  // new
  };
  
  // App.tsx — add screen in Stack.Navigator
  <Stack.Screen
    name="RecentDetail"
    component={RecentDetailScreen}
    options={({ route }) => ({ title: route.params.entry.title })}
  />
  ```
  ```tsx
  // HomeScreen.tsx — wrap List.Item
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
- **MIRROR**: `NAV_PARAM_REGISTRATION`, `STACK_SCREEN_REGISTRATION`, `TYPED_NAV_NAVIGATE`.
- **IMPORTS**: `RecentDetailScreen` from the new screen file; `CaptureEntry` from storage.
- **GOTCHA**:
  - Native-stack header truncates long titles with `…`. Accept it.
  - The `refresh` on focus listener (`HomeScreen.tsx:39-45`) already fires when RecentDetail pops back — no extra wiring needed.
- **VALIDATE**: Task 9 manual flow — tap a recent, see detail, back → recent gone if deleted.

### Task 6: Storage tests
- **ACTION**: Create `apps/mobile/src/lib/storage.test.ts`.
- **IMPLEMENT**:
  ```ts
  import { beforeEach, describe, expect, it, vi } from "vitest";
  
  // In-memory AsyncStorage mock
  const _store = new Map<string, string>();
  vi.mock("@react-native-async-storage/async-storage", () => ({
    default: {
      getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => { _store.set(k, v); }),
      removeItem: vi.fn(async (k: string) => { _store.delete(k); }),
    },
  }));
  
  import {
    getRecentCaptures,
    recordCapture,
    removeFromHistory,
    type CaptureEntry,
  } from "./storage";
  
  function entry(id: string, t = Date.now()): CaptureEntry {
    return { id, mode: "idea", title: `e-${id}`, filepath: `/v/${id}.md`, createdAt: t };
  }
  
  describe("recents history", () => {
    beforeEach(() => { _store.clear(); });
  
    it("starts empty", async () => {
      expect(await getRecentCaptures()).toEqual([]);
    });
  
    it("records in MRU order", async () => {
      await recordCapture(entry("a"));
      await recordCapture(entry("b"));
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["b", "a"]);
    });
  
    it("caps at HISTORY_LIMIT (20)", async () => {
      for (let i = 0; i < 25; i++) await recordCapture(entry(`${i}`));
      const xs = await getRecentCaptures();
      expect(xs).toHaveLength(20);
      expect(xs[0].id).toBe("24");
      expect(xs[19].id).toBe("5");
    });
  
    it("removeFromHistory deletes by id and preserves order", async () => {
      await recordCapture(entry("a"));
      await recordCapture(entry("b"));
      await recordCapture(entry("c"));
      await removeFromHistory("b");
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["c", "a"]);
    });
  
    it("removeFromHistory on non-existent id is a no-op", async () => {
      await recordCapture(entry("a"));
      await removeFromHistory("nonexistent");
      const xs = await getRecentCaptures();
      expect(xs.map((e) => e.id)).toEqual(["a"]);
    });
  });
  ```
- **MIRROR**: `TEST_STRUCTURE` (the in-memory store + vi.mock pattern from `writer.test.ts`).
- **IMPORTS**: shown above.
- **GOTCHA**: `@react-native-async-storage/async-storage` exports a default — mock as `{ default: {...} }` or vitest won't bind correctly.
- **VALIDATE**: `npm -w @carnet/mobile run test`.

### Task 7: Writer tests for moveToArchive
- **ACTION**: Extend `apps/mobile/src/lib/writer.test.ts` with cases for `moveToArchive`.
- **IMPLEMENT**:
  ```ts
  describe("moveToArchive", () => {
    beforeEach(clearFiles);
  
    it("archives a standalone idea note", async () => {
      const { filepath } = await writeIdea("test-idea", "# Test\n\nbody\n");
      const { archivedMdPath, archivedBinaryPath } = await moveToArchive(filepath);
      expect(archivedMdPath).toContain("/Archive/");
      expect(archivedBinaryPath).toBeNull();
      // Source gone
      const sourceAfter = await getInfoAsync(filepath);
      expect(sourceAfter.exists).toBe(false);
    });
  
    it("archives an idea with a paired Audio file", async () => {
      // Pre-populate a fake binary
      await writeBinary("Audio", "song.mp3", "AAAA", "audio/mpeg");
      const ideaMd = `# Test\n\n## File\n[song.mp3](../Audio/song.mp3)\n`;
      const { filepath } = await writeIdea("paired", ideaMd);
  
      const result = await moveToArchive(filepath);
      expect(result.archivedMdPath).toContain("/Archive/");
      expect(result.archivedBinaryPath).toContain("/Archive/song");
    });
  
    it("archives just the .md when the paired binary is missing", async () => {
      const ideaMd = `# Test\n\n## File\n[ghost.mp3](../Audio/ghost.mp3)\n`;
      const { filepath } = await writeIdea("orphan", ideaMd);
  
      const result = await moveToArchive(filepath);
      expect(result.archivedMdPath).toContain("/Archive/");
      expect(result.archivedBinaryPath).toBeNull();
    });
  
    it("collision-bumps when archiving two notes with the same stem", async () => {
      const m1 = await writeIdea("dup", "# v1\n");
      await moveToArchive(m1.filepath);
      const m2 = await writeIdea("dup", "# v2\n");
      const result = await moveToArchive(m2.filepath);
      expect(result.archivedMdPath).toMatch(/\/Archive\/dup-2\.md$/);
    });
  });
  ```
- **MIRROR**: existing `writer.test.ts` describe blocks.
- **IMPORTS**: import `moveToArchive` from `./writer`; reuse the `_files` map + `getInfoAsync` mock already wired.
- **GOTCHA**:
  - Need to add `deleteAsync` to the `vi.mock("expo-file-system/legacy", …)` block:
    ```ts
    deleteAsync: vi.fn(async (uri: string) => { _files.delete(uri); }),
    ```
  - Tests run on the file:// branch (no SAF). SAF branch is exercised on-device only.
- **VALIDATE**: `npm -w @carnet/mobile run test`.

### Task 8: Run validation suite
- **ACTION**: `npm -w @carnet/mobile run typecheck` then `npm -w @carnet/mobile run test`.
- **VALIDATE**: Zero type errors. Tests: prior 117 + ~9 new (5 storage + 4 moveToArchive) = ~126 passing.

### Task 9: On-device manual validation
- **ACTION**: `npx expo run:android` to rebuild (no prebuild needed — RN-markdown-display is pure JS).
- **VALIDATE**: see Manual Validation checklist below.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| `getRecentCaptures` on empty store | `[]` storage | `[]` | yes |
| `recordCapture` MRU order | 2 entries in sequence | newest first | no |
| `recordCapture` caps at 20 | 25 entries | 20 entries, newest first | yes |
| `removeFromHistory` by id | id exists | remaining preserve order | no |
| `removeFromHistory` non-existent id | id missing | no-op | yes |
| `moveToArchive` standalone note | .md only | Archive/ has .md; source gone | no |
| `moveToArchive` with paired Audio | .md + .mp3 in link | both moved | no |
| `moveToArchive` paired binary missing | .md with broken link | only .md moved; null binary | yes |
| `moveToArchive` collision bump | second archive of same stem | `dup-2.md` | yes |

### Edge Cases Checklist
- [x] Empty input (empty recents, empty markdown body)
- [x] Maximum size input (HISTORY_LIMIT)
- [x] Invalid types — covered by TS at compile time
- [x] Concurrent access — recents are user-driven and serial; no race expected. moveToArchive guarded by `deletingRef`.
- [x] Network failure — N/A; entirely local
- [x] Permission denied — SAF revocation handled by try/catch around delete; archive copy succeeds, source remains (intentional)
- [x] Markdown with frontmatter only, no body — strip leaves empty body; render shows empty
- [x] Markdown with emoji — covered by omitting custom fontFamily in markdownStyle

---

## Validation Commands

### Static Analysis
```bash
npm -w @carnet/mobile run typecheck
```
EXPECT: Zero type errors.

### Unit Tests
```bash
npm -w @carnet/mobile run test
```
EXPECT: ~126 tests pass (was 117 + ~9 new). All 6 test files green.

### Browser / Device Validation
```bash
# Reinstall dev client (no prebuild — pure JS dep):
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk \
  PATH="/home/user/Android/Sdk/platform-tools:$PATH" \
  npx expo run:android
```
EXPECT: App launches, no Metro red screen, no Android crash on Home.

### Manual Validation
- [ ] Capture an Idea → recent row tappable → detail opens with the .md body rendered
- [ ] Tap Delete → confirm dialog → Cancel: stays put → Delete: file moves to `Archive/`, history entry gone, returned to Home, recents list refreshed without the entry
- [ ] Capture a Photo → tap recent → detail shows the inline image embed + markdown body
- [ ] Share an audio file (PR #7) → tap recent → detail shows audio file link
- [ ] Capture an Idea → in a file manager rename the .md → re-open carnet → tap that recent → missing banner appears → "Remove from recents" works
- [ ] Capture 21+ items in a row → only most recent 20 appear on Home
- [ ] Two captures with identical title → both archive cleanly with collision-bumped names
- [ ] Long markdown body (>30 lines) scrolls inside the detail card
- [ ] All four existing capture flows still work (idea/journal/person/photo) — regression
- [ ] Both share-receive paths still work (image, url/text, audio, file) — regression
- [ ] Re-enrich on saved phase of ShareReceive still works — regression (we promoted `stripFrontmatter`; verify nothing imports it as `default` somewhere)

---

## Acceptance Criteria
- [ ] All 9 tasks completed
- [ ] `typecheck` clean
- [ ] Test suite ~126/126 passing
- [ ] Manual validation checklist all green
- [ ] No regression in 4 capture modes, both share-receive paths, photo capture, or re-enrich

## Completion Checklist
- [ ] Code follows discovered patterns (CARD_ACTIONS_LAYOUT, IN_FLIGHT_GUARD, REFRESH_ON_FOCUS, etc.)
- [ ] Error handling mirrors codebase style (try/catch + console.warn for non-fatal, throw for fatal)
- [ ] No hardcoded values (HISTORY_LIMIT and Archive subdir name are the constants)
- [ ] Tests follow `writer.test.ts` mock pattern
- [ ] No `console.log` statements
- [ ] No unnecessary scope additions (everything in NOT Building stays out)
- [ ] Plan self-contained — implementer should not need to grep further

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `react-native-markdown-display` rejects RN 0.81 peer dep | Medium | npm warn, possibly install failure | Swap to `@ronradtke/react-native-markdown-display` fork; accept warn otherwise |
| SAF delete fails on revoked permission | Medium | Stranded duplicate in `Archive/` | `deleteByUri` wrapped in try/catch; "copied to Archive/ but couldn't remove source" toast can ship in a follow-up |
| Paired-binary regex misses non-standard relative paths | Low | Orphaned binary in vault after archive | Regex is permissive (`../{Photos\|Audio\|Files}/`); if missed, just .md archives — acceptable |
| Markdown renderer crashes on edge-case content (Obsidian plugin syntax) | Medium | Ugly preview only | Stripping frontmatter avoids most; complex bodies fall back to raw text in a follow-up PR if reported |
| Fast double-tap on Delete | Low | Double-archive attempt (collision-bumped — safe) or stale UI | `deletingRef` in-flight guard prevents the second handler from running |
| `stripFrontmatter` export breaks an internal consumer of the private signature | Very Low | TS error | Only used internally today; promoting to export is additive |

## Notes
- This plan deliberately keeps the Detail screen READ-ONLY. The next iteration (slate #6) adds an "Edit" toggle that swaps the `<Markdown>` block for a `<TextInput multiline>` and calls `updateNote(filepath, newBody)` on save. Same screen, additive change.
- The 20-item cap is a pragmatic v0.3 number. If users ask "where's last month's capture?", direct them to Obsidian — that's still the search surface.
- Soft-delete only. `Archive/` accumulates over time and the user prunes it manually in Obsidian. A future "Empty archive older than 90 days" toggle in Settings is a follow-up.
- After this PR lands, slate #5 (retro-enrich any past capture) becomes trivial: add a "Re-enrich" Button to RecentDetail's action card, reuse `enrichSharedImage`/`enrichSharedLink` based on the frontmatter `kind`, and call `updateNote`.
