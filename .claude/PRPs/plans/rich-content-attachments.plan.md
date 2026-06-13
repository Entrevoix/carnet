# Plan: Rich Content — Image/File Attachments in Notes (+ optional Karakeep export)

> STATUS (2026-06-13): Phase 1 (attach images/files to Idea/Journal captures + inline render in RecentDetail) SHIPPED (#30 b15a4d8). Phase 2 (Karakeep export) NOT built — needs the Karakeep endpoint/format decisions before it can start. This plan stays active for Phase 2.

## Summary
Let users manually attach images and arbitrary files to **Idea** and **Journal** captures (today binaries only enter via Photo mode or Android share-in), persist them with the existing `writeBinary` plumbing, reference them by the established `../Subdir/file` convention, and **render them inline** in the note-detail view. This completes carnet's half-built local-first attachment model. **Phase 2** (designed here, lighter detail) adds an optional "Send to Karakeep" export so a note/link/file can be pushed to a self-hosted Karakeep archive.

## User Story
As a carnet user, I want to attach images and files to my idea/journal notes and see them rendered in the note, so that a capture can hold richer context than plain text — while still living as a markdown file in my own folder.

## Problem → Solution
**Current:** Captures are text-first. The storage layer already pairs binaries (`Photos/`, `Audio/`, `Files/`) and references them by relative path, but (a) there's no way to attach an image/file to an Idea/Journal note on purpose, and (b) attachments don't render in `RecentDetail` (the markdown renderer never resolves the relative/SAF URIs).
**Desired:** An "Attach" affordance on Idea/Journal capture writes picked media via `writeBinary`, injects the standard embed/link, and stays offline-safe through the queue; the detail screen resolves and renders attachments (images inline, files as tappable rows) using the audio-player precedent.

## Metadata
- **Complexity**: Large (cross-cutting: capture UI, writer, queue, detail rendering, settings; + 1-2 new native modules)
- **Source PRD**: N/A (free-form `/prp-plan` request: "rich text and content (images, etc.) maybe attachments too? or a link to karakeep?")
- **PRD Phase**: N/A
- **Estimated Files**: Phase 1 ≈ 6-8 files; Phase 2 ≈ 3-4 files
- **Direction chosen by user**: *Phased — native attachments now, Karakeep export as a follow-on.*

---

## UX Design

### Before
```
┌──────────────────────────────┐
│  Idea                        │
│  [🎙 Tap to dictate]          │
│  ┌──────────────────────────┐ │
│  │ Your idea (text only)    │ │
│  └──────────────────────────┘ │
│        [ Send ]              │
└──────────────────────────────┘
  Note detail = text only; any
  ![](../Photos/x) shows as a
  broken/raw markdown line.
```

### After
```
┌──────────────────────────────┐
│  Idea                        │
│  [🎙 Tap to dictate]          │
│  ┌──────────────────────────┐ │
│  │ Your idea …              │ │
│  └──────────────────────────┘ │
│  [📎 Attach image] [📄 File]  │
│  ▸ pending: sketch.jpg ✕      │
│  ▸ pending: spec.pdf ✕        │
│        [ Send ]              │
└──────────────────────────────┘
  Note detail renders an
  "Attachments" card: images
  inline (<Image>), files as
  tappable rows that open/share.
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Idea/Journal capture | text + voice | text + voice + **attach image/file** | New button row under the input |
| Pending attachments | n/a | chips with remove (✕) before send | Held in component state |
| Save (online) | enrich → preview → write | enrich → preview → write **+ binaries + embeds** | Binaries written at confirmSave (no orphans on cancel) |
| Save (offline) | enqueue text | enqueue text **+ attachment rel-paths** | Binaries written at enqueue; drain injects embeds |
| Note detail | markdown text only | markdown text **+ Attachments card** | Attachment lines stripped from text body, shown in the card |
| Archive/delete | removes 1 paired binary | removes **all** paired binaries | `moveToArchive` regex → `matchAll` |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/lib/writer.ts` | 48-61, 369-378, 580-629, 676-704, 738-760, 860-916 | Root resolution, embed injection, writeBinary, paired-binary read/regex — the keystone |
| P0 | `src/screens/ShareReceiveScreen.tsx` | 172-222, 284-330 | The exact base64→writeBinary→inject→writeIdea pattern to mirror |
| P0 | `src/screens/CaptureScreen.tsx` | 88-260, 464-492 | Where attach UI + state + confirmSave hook in; existing submit/handleCaptureError flow |
| P0 | `src/lib/queue.ts` | (whole file) | Extend payloads with attachment rel-paths; drain injection (offline-safe) |
| P1 | `src/screens/RecentDetailScreen.tsx` | 323-389, 414-416, 661-704 | Audio-player precedent + markdown render; where the Attachments card goes |
| P1 | `src/lib/shareHelpers.ts` | 64-73 | `readShareFileAsBase64` (content:// vs file://) — reuse for picked URIs |
| P1 | `src/lib/settings.ts` | 37-59, 167-200 | Settings shape + SecureStore key handling (Phase 2 Karakeep fields) |
| P2 | `src/screens/SettingsScreen.tsx` | 189-215, 369-422 | TextInput + secure-key save pattern (Phase 2) |
| P2 | `src/lib/writer.test.ts` | 1-92 | Test harness: in-memory FileSystem mock, exports under test |
| P2 | `src/lib/omniroute.ts` | 89-103, 203-266, 326-346 | Thin fetch-client + error classification pattern (Phase 2 Karakeep client) |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| expo-document-picker (SDK 54) | https://docs.expo.dev/versions/latest/sdk/document-picker/ | Pick images+files; set `copyToCacheDirectory:true` so the URI is readable immediately |
| expo-image-picker (optional) | https://docs.expo.dev/versions/latest/sdk/imagepicker/ | Nicer image UX; request media-library permission *before* opening picker (SDK-54 passthrough) |
| react-native-markdown-display images | https://github.com/iamacup/react-native-markdown-display | `allowedImageHandlers`/`defaultImageHandler` needed for inline images; **does not resolve relative or `content://` paths** → we render attachments in a dedicated card instead |
| Expo file-system (SAF) | https://docs.expo.dev/versions/latest/sdk/filesystem/ · expo/expo#20102 | `content://` SAF folders: relative paths don't resolve; resolve each child URI explicitly |
| Karakeep API (Phase 2) | https://docs.karakeep.app/api/karakeep-api/ | Bearer auth at `{base}/api/v1`; `POST /bookmarks` (link/text/asset), `POST /assets` multipart `file` → `assetId` |
| Karakeep SDK (Phase 2) | https://www.npmjs.com/package/@karakeep/sdk | Official typed client — *optional*; a thin fetch client mirroring `omniroute.ts` is more consistent and dep-free |

---

## Patterns to Mirror

### BINARY_WRITE
```ts
// SOURCE: src/lib/writer.ts:676-704
export async function writeBinary(subdir, filename, base64, mimeType):
  Promise<{ filepath: string; finalName: string }> {
  const root = await resolveRoot();
  const dirUri = await findOrCreateSubdir(root, subdir);
  // …collision-bump…
  const finalName = await findCollisionFreeName(dirUri, stem, ext, root.isSaf);
  if (root.isSaf) { /* StorageAccessFramework.createFileAsync + writeAsStringAsync(Base64) */ }
  else { /* FileSystem.writeAsStringAsync(Base64) */ }
  return { filepath, finalName };   // finalName carries the collision-bumped stem
}
```

### EMBED_INJECT (images)
```ts
// SOURCE: src/lib/writer.ts:369-378
export function injectImageEmbed(markdown: string, relPath: string): string {
  const embed = `![](${relPath})`;          // relPath e.g. ../Photos/sketch-2.jpg
  const match = markdown.match(/^(#\s+.+?)(\r?\n|$)/m);
  if (!match) return `${embed}\n\n${markdown}`;
  // …insert two lines after H1…
}
```

### FILE_LINK (non-image attachments)
```ts
// SOURCE: src/screens/ShareReceiveScreen.tsx:312-320 (stub note)
`## File\n[${fileName}](../Files/${finalName})\n`
// generic links use [name](../Files/x); images use ![](../Photos/x)
```

### SHARE_IMAGE_FLOW (the canonical attach sequence)
```ts
// SOURCE: src/screens/ShareReceiveScreen.tsx:172-222
const base64 = await readShareFileAsBase64(imageFile.path);   // content:// or file://
assertBase64UnderLimit(base64);
const { finalName } = await writeBinary("Photos", `${slug}.${ext}`, base64, mime);
const sharedStem = finalName.replace(/\.[^.]+$/, "");
const withImage = injectImageEmbed(enrichedMd, `../Photos/${finalName}`);
const { filepath } = await writeIdea(sharedStem, withImage);
```

### PAIRED_BINARY_READ (resolve a link to a storage URI)
```ts
// SOURCE: src/lib/writer.ts:860-877
export async function readPairedBinaryUri(body):
  Promise<{ uri: string; mime: string; filename: string }> {
  const linkMatch = body.match(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/);  // single match today
  // resolveRoot → findOrCreateSubdir → findFileInDir → return file:// or content:// URI
}
```

### OFFLINE_QUEUE_PAYLOAD (extend with attachments)
```ts
// SOURCE: src/lib/queue.ts:46-64 (current)
export interface IdeaPayload { mode: "idea"; text: string; }
// Phase-1 extension: add `attachments?: AttachmentRef[]` to Idea/Journal payloads;
// processRow injects embeds/links before writeIdea/appendJournal.
```

### MEDIA_CARD_RENDER (precedent = audio player)
```tsx
// SOURCE: src/screens/RecentDetailScreen.tsx:323-389
// Resolve URI off the body (readPairedBinaryUri) → render a dedicated <Card>
// with media controls. Phase 1 mirrors this with an "Attachments" card.
<Card style={styles.card}><Card.Content>{/* image / file rows */}</Card.Content></Card>
```

### SECURE_SETTING (Phase 2 Karakeep key)
```ts
// SOURCE: src/lib/settings.ts:167-200 + src/screens/SettingsScreen.tsx:189-215
// API keys live in SecureStore, never in persisted JSON or form state.
if (settings.omniRouteApiKey) await SecureStore.setItemAsync(OMNIROUTE_API_KEY, ...);
```

### TEST_HARNESS
```ts
// SOURCE: src/lib/writer.test.ts:1-92
// In-memory Map<string,{content}> mock of expo-file-system/legacy (+ SAF stub).
// Assert writeBinary/injectImageEmbed/readPairedBinaryFromNote against the map.
```

---

## Files to Change

### Phase 1 — Native Attachments
| File | Action | Justification |
|---|---|---|
| `package.json` | UPDATE | Add `expo-document-picker` (and optionally `expo-image-picker`) via `npx expo install` |
| `src/lib/attachments.ts` | CREATE | Small helper: pick → read base64 → classify (image vs file) → size cap. Wraps document/image picker + `readShareFileAsBase64`-style read |
| `src/lib/writer.ts` | UPDATE | Add `listPairedBinaries(body)` (`matchAll`), `resolvePairedUri(subdir,filename)`; switch `moveToArchive` to `matchAll` so all attachments are archived |
| `src/lib/queue.ts` | UPDATE | Extend `IdeaPayload`/`JournalPayload` with `attachments?: AttachmentRef[]`; inject embeds/links in `processRow` |
| `src/screens/CaptureScreen.tsx` | UPDATE | Attach button row + pending-attachment chips + state; write binaries & inject at `confirmSave` (online) / enqueue (offline) |
| `src/screens/RecentDetailScreen.tsx` | UPDATE | "Attachments" card: resolve URIs, render images inline + files as tappable rows; strip attachment lines from the rendered text body |
| `src/lib/writer.test.ts` | UPDATE | Tests for `listPairedBinaries`, `matchAll` archive, multi-embed injection |
| `src/lib/queue.test.ts` | UPDATE | Tests: enqueue+drain with `attachments` injects correct embeds/links |

### Phase 2 — Karakeep Export (follow-on)
| File | Action | Justification |
|---|---|---|
| `src/lib/karakeep.ts` | CREATE | Thin fetch client: `createBookmarkFromNote`, `uploadAsset` (mirror `omniroute.ts` error model) |
| `src/lib/settings.ts` | UPDATE | Add `karakeepUrl` + `karakeepApiKey` (SecureStore) mirroring OmniRoute |
| `src/screens/SettingsScreen.tsx` | UPDATE | Karakeep URL + key fields (mirror OmniRoute block) |
| `src/screens/RecentDetailScreen.tsx` | UPDATE | "Send to Karakeep" action (visible only when configured) |

## NOT Building
- **Rich-text / WYSIWYG editor** — stays plain markdown; a future light formatting toolbar is out of scope (every RN RTE drags in a WebView + HTML↔markdown serialization).
- **Vision enrichment of attached images in Idea/Journal** — attachments are embedded, not sent to OmniRoute (Photo mode already covers vision capture).
- **Editing/adding attachments to an already-saved note** — Phase 1 attaches at capture time only (could be a later RecentDetail edit-mode task).
- **Person/Photo/Audio mode changes** — attachments target Idea + Journal.
- **Markdown-renderer inline-image resolution** — deliberately avoided; attachments render in a dedicated card (renderer can't resolve relative/`content://` URIs).
- **Karakeep two-way sync / pulling bookmarks back** — Phase 2 is push-only export.

---

## Step-by-Step Tasks (Phase 1)

### Task 1: Add the picker dependency
- **ACTION**: Install `expo-document-picker` (covers images + arbitrary files in one native module). Optionally add `expo-image-picker` for nicer image selection.
- **IMPLEMENT**: `cd apps/mobile && npx expo install expo-document-picker` (lets Expo pick the SDK-54-compatible version).
- **MIRROR**: existing expo native modules in `package.json` (`expo-camera ~17.0.10`, `expo-av ~16.0.8`).
- **GOTCHA**: This is a **new native module** → requires `npx expo prebuild` regen + a **full release build** to verify on-device (JS-only checks won't surface native link errors). See memory [[native-plugin-kotlin-verification]]. Do **not** run `expo install --fix` (it can downgrade worklets — see [[expo-doctor-worklets-downgrade-trap]]).
- **VALIDATE**: `npx tsc --noEmit` clean; `npm run android:release` builds; app launches.

### Task 2: `src/lib/attachments.ts` — pick + read + classify
- **ACTION**: Create a helper that opens the picker, reads the chosen URI to base64, classifies image vs file, and enforces the size cap.
- **IMPLEMENT**:
  - `pickAttachment(): Promise<PickedAttachment | null>` using `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })`.
  - Read base64 via the same scheme-branching as `readShareFileAsBase64` (content:// → `StorageAccessFramework.readAsStringAsync`, else `FileSystem.readAsStringAsync`, Base64).
  - `kind = mime.startsWith("image/") ? "image" : "file"`; derive `ext` via `extFromMime`.
  - Reuse `MAX_SAFE_SHARE_BYTES` / `assertBase64UnderLimit` semantics (re-export or import from the share path) and `sanitizeShareString` for filenames.
  - Return `{ base64, mime, filename, kind }`.
- **MIRROR**: `src/lib/shareHelpers.ts:64-73` (read), `ShareReceiveScreen.tsx:284-330` (sanitize + size cap + ext).
- **IMPORTS**: `expo-document-picker`, `expo-file-system/legacy` (`FileSystem`, `StorageAccessFramework`), `extFromMime`/`sanitizeShareString` from writer/shareHelpers.
- **GOTCHA**: `copyToCacheDirectory:true` returns a readable cache `file://` URI; some providers still hand back `content://` — keep both branches.
- **VALIDATE**: unit test the classify + size-cap logic with a mocked picker result.

### Task 3: writer.ts — multi-attachment helpers + `matchAll` archive
- **ACTION**: Add `listPairedBinaries(body)` and `resolvePairedUri(subdir, filename)`; make `moveToArchive` handle **all** paired binaries.
- **IMPLEMENT**:
  - `export function listPairedBinaries(body): { subdir: "Photos"|"Audio"|"Files"; filename: string; rel: string }[]` using `body.matchAll(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/g)`.
  - `export async function resolvePairedUri(subdir, filename): Promise<{uri,mime}|null>` factoring the resolve logic currently inside `readPairedBinaryUri` (root → `findOrCreateSubdir` → `findFileInDir` → `mimeFromFilename`). Refactor `readPairedBinaryUri`/`readPairedBinaryFromNote` to call it (no behavior change for the single-match callers).
  - In `moveToArchive` (writer.ts:738-760): replace the single `.match()` with `listPairedBinaries(content)` and archive each (loop the existing single-binary move).
- **MIRROR**: writer.ts:860-877 (resolve), 738-760 (archive).
- **IMPORTS**: none new.
- **GOTCHA**: keep the traversal-safe class `[^/\s)]+` (rejects `/`). Preserve the order; the first image is still the "primary" for any single-match callers.
- **VALIDATE**: `writer.test.ts` — note with 0/1/3 attachments → `listPairedBinaries` length; `moveToArchive` removes all.

### Task 4: queue.ts — offline-safe attachments
- **ACTION**: Carry attachment references through the offline queue so attaching while offline never drops the binary.
- **IMPLEMENT**:
  - `export interface AttachmentRef { kind: "image" | "file"; rel: string; filename: string; }` (`rel` = `../Photos/x.jpg` or `../Files/x.pdf`).
  - Add `attachments?: AttachmentRef[]` to `IdeaPayload` and `JournalPayload`.
  - In `processRow`, after building enriched markdown, fold attachments in: `for (a of attachments) md = a.kind==="image" ? injectImageEmbed(md, a.rel) : appendFileLink(md, a)` before `writeIdea`/`appendJournal`. Add a tiny `appendFileLink(md, a)` (or reuse `upsertSection(md, "Files", "[name](rel)")`).
- **MIRROR**: queue.ts `processRow` (idea/journal branches); writer `injectImageEmbed`/`upsertSection`.
- **IMPORTS**: `injectImageEmbed`, `upsertSection` from `./writer`.
- **GOTCHA**: binaries are written to disk **before** enqueue (they're local + offline-safe); the queue carries only `rel` paths, never base64 (keep the queue small, mirrors the "API key not in queue" rule).
- **VALIDATE**: `queue.test.ts` — enqueue idea with `attachments:[{image},{file}]` → drain → asserted body contains `![](../Photos/…)` and `[name](../Files/…)`.

### Task 5: CaptureScreen — attach UI + write/inject at commit
- **ACTION**: Add an attach row + pending-attachment state to Idea/Journal; write binaries and inject references at the commit moment.
- **IMPLEMENT**:
  - State: `const [pending, setPending] = useState<PickedAttachment[]>([])`.
  - UI: under the input (CaptureScreen.tsx:464-492 region), a button row `[📎 Attach image] [📄 Attach file]` (react-native-paper `Button`/`IconButton`) → `pickAttachment()` → push to `pending`; render each as a paper `Chip` with `onClose` to remove.
  - **Online path** (`confirmSave`, ~241-260): for each pending, `writeBinary(kind==="image"?"Photos":"Files", `${slug}.${ext}`, base64, mime)`; build `AttachmentRef[]` from `finalName`; inject into `pendingIdea.markdown` (images via `injectImageEmbed`, files via file-link) **before** `writeIdea`/`appendJournal`. Clear `pending`.
  - **Offline path** (`handleCaptureError` → enqueue, CaptureScreen.tsx:140-150): write binaries to disk first, then `enqueue({ mode, text, attachments })` with the `rel` paths.
  - Disable/hide attach buttons in `submitting`/`preview` phases as appropriate.
- **MIRROR**: ShareReceiveScreen.tsx:172-222 (image), 284-330 (file); existing `confirmSave`/`handleCaptureError`.
- **IMPORTS**: `pickAttachment` from `../lib/attachments`; `writeBinary`, `injectImageEmbed` from `../lib/writer`.
- **GOTCHA**: write binaries at **confirmSave** (not submit) to avoid orphaned files if the user cancels at preview; for the offline branch, write at enqueue (a committed moment). Use `finalName` (collision-bumped) for the embed, not the requested name.
- **VALIDATE**: on-device — attach an image to an Idea online → note shows it; airplane-mode → attach + send → drains later with the image.

### Task 6: RecentDetailScreen — Attachments card + clean body
- **ACTION**: Render attachments in a dedicated card and stop the raw `![]()`/link lines from cluttering the text body.
- **IMPLEMENT**:
  - Compute `const atts = listPairedBinaries(body)`; resolve each via `resolvePairedUri`.
  - Render an "Attachments" `<Card>` (mirror the audio-player card, 323-389): images via RN `<Image source={{uri}} style={...}>`; non-image files as a row with an icon + filename + `onPress` → `Sharing.shareAsync(uri)` (expo-sharing) or `Linking.openURL`.
  - For the markdown text: strip attachment lines from `renderBody` (remove lines matching the paired-binary regex / the `![](../…)`/`[..](../Files/…)` forms) so the renderer shows clean prose; keep `stripFrontmatter`.
  - Audio (`kind: shared-audio`) keeps its existing dedicated player; don't double-render it as a generic file.
- **MIRROR**: RecentDetailScreen.tsx:323-389 (card), 414-416 (render), 661-704 (styles).
- **IMPORTS**: `listPairedBinaries`, `resolvePairedUri` from `../lib/writer`; RN `Image`; `expo-sharing` (already? else `Linking`).
- **GOTCHA**: RN `<Image>` renders `file://` directly; for SAF `content://` it generally works via the Android loader — if a device shows blanks, fall back to `expo-image` (note as a contingency, don't add the dep pre-emptively). Resolution is async → load URIs in an effect, render from state.
- **VALIDATE**: open a note with 1 image + 1 pdf → image renders, pdf row opens; a text-only note is unchanged.

### Task 7: Validation sweep (Phase 1)
- **ACTION**: Typecheck, unit tests, release build, on-device QA.
- **VALIDATE**: see Validation Commands.

---

## Step-by-Step Tasks (Phase 2 — Karakeep Export, follow-on)

### Task 8: settings — Karakeep URL + key
- **ACTION**: Add `karakeepUrl` (persisted) + `karakeepApiKey` (SecureStore) mirroring OmniRoute exactly.
- **MIRROR**: settings.ts:37-59, 167-200 (`OMNIROUTE_API_KEY` handling); add `KARAKEEP_API_KEY` const + read/write in `getSettings`/`saveSettings`.
- **VALIDATE**: settings round-trip test (mirror existing settings tests).

### Task 9: `src/lib/karakeep.ts` — thin client
- **ACTION**: Hand-rolled fetch client (consistent with `omniroute.ts`; avoids the `@karakeep/sdk` dep).
- **IMPLEMENT**: `createTextBookmark(text, title?)` → `POST {base}/api/v1/bookmarks {type:"text",text}`; `createLinkBookmark(url)`; `uploadAsset(base64,mime,filename)` → `POST /assets` multipart `file` → `assetId` → `POST /bookmarks {type:"asset",assetType,assetId}`. Bearer auth from SecureStore. Reuse `withTimeout` + `OmniRouteError`-style status classification (consider a shared `httpClient` or copy the pattern).
- **MIRROR**: omniroute.ts:203-266 (fetch+timeout), 89-103 (error class), 326-346 (config read + not-configured guard).
- **GOTCHA**: self-hosted Karakeep is typically LAN/tailnet-only (same reachability caveat as OmniRoute) — surface a not-configured / unreachable error rather than hanging; reuse the `notConfigured` discriminator pattern just added to omniroute.
- **VALIDATE**: unit tests with `fetch` mock (mirror omniroute.test.ts): text bookmark POST shape, asset upload two-step, bearer header, not-configured error.

### Task 10: RecentDetail — "Send to Karakeep"
- **ACTION**: Action (menu item/button) visible only when Karakeep is configured; sends the note text as a text bookmark and uploads any image/file attachments as assets.
- **MIRROR**: existing RecentDetail action buttons (re-enrich/transcribe).
- **GOTCHA**: fire-and-forget with explicit success/error feedback (snackbar); consider routing failures through an export queue later (out of scope now).
- **VALIDATE**: on-device against a reachable Karakeep instance (manual).

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected | Edge? |
|---|---|---|---|
| `listPairedBinaries` none | body w/ no links | `[]` | yes |
| `listPairedBinaries` multi | body w/ Photos+Files+Audio links | 3 entries, correct subdir/filename | yes |
| `injectImageEmbed` multi | inject 2 images sequentially | both embeds under H1, order stable | yes |
| `moveToArchive` matchAll | note + 2 binaries | both binaries moved to Archive | yes |
| queue drain w/ attachments | enqueue idea `{text, attachments:[img,file]}` | drained body has `![](../Photos/…)` + `[..](../Files/…)` | yes |
| attachments.classify | image/jpeg vs application/pdf | `kind` image vs file | no |
| size cap | base64 over `MAX_SAFE_SHARE_BYTES` | throws cap error | yes |
| karakeep text bookmark (P2) | mocked fetch 201 | POST `/bookmarks` `{type:"text"}`, bearer header | no |
| karakeep not-configured (P2) | blank URL | `notConfigured` error, no fetch | yes |

### Edge Cases Checklist
- [ ] Attach then remove a pending attachment before send
- [ ] Attach while offline → enqueue → drain injects embed
- [ ] Cancel at preview → no orphaned binary on disk (online path writes at confirmSave)
- [ ] SAF (`content://`) folder: write + resolve + render
- [ ] Collision: two attachments with same name → `-2` bump, links stay paired
- [ ] Oversized file → friendly cap error, capture not lost
- [ ] Note with image embed renders inline; pdf row opens; audio still uses its player

---

## Validation Commands

### Static Analysis
```bash
cd apps/mobile && npx tsc --noEmit
```
EXPECT: Zero type errors

### Unit Tests
```bash
cd apps/mobile && npx vitest run src/lib/writer.test.ts src/lib/queue.test.ts src/lib/attachments.test.ts
```
EXPECT: All pass

### Full Test Suite
```bash
cd apps/mobile && npx vitest run
```
EXPECT: No regressions (currently 223 passing)

### Release Build (required — new native module)
```bash
cd apps/mobile && npm run android:release
```
EXPECT: BUILD SUCCESSFUL; APK at android/app/build/outputs/apk/release/app-release.apk

### Manual / On-device Validation
- [ ] `adb install -r` the release APK
- [ ] Idea → Attach image (library) → Send (online) → open note → image renders
- [ ] Idea → Attach file (pdf) → Send → file row opens/shares
- [ ] Airplane mode → Idea + attach → Send → "Offline — capture queued."; reopen Capture online → drains with attachment
- [ ] Archive a note with 2 attachments → both binaries gone from Photos/Files
- [ ] (P2) Configure Karakeep URL/key in Settings → "Send to Karakeep" → bookmark appears in Karakeep

---

## Acceptance Criteria
- [ ] Attach image + file to Idea and Journal captures
- [ ] Attachments persist via `writeBinary` and use the `../Subdir/file` convention
- [ ] Offline attach → queue carries rel-paths → drain injects embeds (no dropped binaries)
- [ ] Attachments render in RecentDetail (images inline, files tappable); text body stays clean
- [ ] `moveToArchive` removes all paired binaries
- [ ] tsc clean, full vitest green, release build succeeds, on-device QA passes
- [ ] (Phase 2) Karakeep settings + push export behind a configured guard

## Completion Checklist
- [ ] Mirrors writer/share/queue patterns (no new conventions invented)
- [ ] Errors handled like existing capture flow (size caps, offline, not-configured)
- [ ] No base64 in the queue; secrets in SecureStore (P2)
- [ ] Tests follow `writer.test.ts`/`queue.test.ts` harness
- [ ] Native rebuild done + verified on-device
- [ ] No scope creep (no WYSIWYG editor; no Karakeep two-way sync)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New native module (document/image picker) breaks build | Med | High | `npx expo install` (SDK-matched), full release build to verify, never `--fix` ([[expo-doctor-worklets-downgrade-trap]]) |
| RN `<Image>` won't render SAF `content://` on some devices | Med | Med | Resolve per-child URI; contingency: add `expo-image` |
| Offline queue payload change desyncs older queued rows | Low | Med | `attachments?` optional → old rows (no field) drain unchanged |
| Orphaned binaries if write/commit interleaves with cancel | Low | Low | Write at confirmSave (online) / enqueue (offline) only |
| Karakeep host unreachable (tailnet) | Med | Low (P2) | Reuse `notConfigured`/timeout surfacing from omniroute |

## Notes
- Audio is the working precedent for "resolve URI → dedicated media card"; the Attachments card follows it rather than fighting `react-native-markdown-display` (which can't resolve relative/`content://` image srcs).
- Keeping base64 out of the queue mirrors the existing "API key is read fresh, never queued" rule and keeps AsyncStorage small.
- Phase 2's thin client intentionally avoids `@karakeep/sdk` to stay consistent with the hand-rolled `omniroute.ts` fetch client and avoid a dependency; swap in the SDK later if typed coverage is wanted.
- This plan is forward-compatible with the user's "phased" choice: Phase 1 ships standalone value; Phase 2 is additive and gated on Karakeep being configured.
```

