# Plan: Attach a photo from the camera to a saved note

Status: shipped

## Summary
Add an **Attach photo** row to a saved note's `⋮` menu that opens the camera,
writes the shot into the vault's `Photos/`, and appends the embed to the note body
on disk. Carnet can already *insert* an image into a note, but only by browsing
files — `pickAttachment` calls `DocumentPicker.getDocumentAsync`, which cannot
take a picture. This closes that gap without touching the capture-time flows.

## User Story
As someone reviewing a note I captured earlier,
I want to photograph something and attach it to that note on the spot,
So that the evidence lands in the right entry instead of a new one.

## Problem → Solution
Attaching a photo to an existing note today means leaving the app, shooting with
the system camera, then re-entering via Edit → image button → file browser →
find the shot in the gallery. → One `⋮` → **Attach photo** → shutter → done.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form request)
- **PRD Phase**: N/A
- **Estimated Files**: 7 (3 new, 4 updated)

---

## Scope correction that shaped this plan

Two beliefs were wrong during exploration; both are corrected here so the
implementer does not re-derive them:

1. **"RecentDetail cannot add attachments."** False. `useNoteEditSession.ts:206`
   (`insertImage`) and `:230` (`insertWysiwygImage`) both already write images
   into the vault and splice the embed in. They are **edit-mode** actions.
2. **"The gap is attachment capability."** False. The gap is the **source**:
   `attachments.ts:47` uses `DocumentPicker.getDocumentAsync({ type: "image/*" })`
   — a file browser. `expo-camera` is already a dependency and is used in
   `PhotoCaptureScreen.tsx` and `CardScannerModal.tsx`, but neither is reachable
   from a saved note.

The real work is therefore: **a camera source, plus a view-mode write path that
respects the concurrent-edit guard.**

---

## UX Design

### Before
```
Saved note ──▶ ⋮ ──▶ Enhance
                     Send to Karakeep
                     File info
                     Delete

To attach a photo:
  leave app → system camera → shoot
  → back to Carnet → Edit → 🖼 button
  → file browser → hunt for the shot
  → Save
```

### After
```
Saved note ──▶ ⋮ ──▶ Enhance
                     Attach photo   ◀── new
                     Send to Karakeep
                     File info
                     Delete
                       │
                       ▼
              ┌──────────────────┐
              │  camera preview  │
              │                  │
              │       ( ● )      │  shutter
              │   [Library] [✕]  │
              └──────────────────┘
                       │
                       ▼
        writes Photos/<slug>.jpg, appends
        ![](../Photos/<slug>.jpg) to the body,
        saves through the mtime guard
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `⋮` menu | 4 rows | 5 rows — **Attach photo** below Enhance | Same `Menu.Item` pattern |
| Camera access from a saved note | none | modal camera with shutter | Mirrors `CardScannerModal` |
| Library access | Edit mode only | also from the modal's **Library** button | Reuses `pickAndWriteVaultImage` |
| Body after attach | unchanged | `![](../Photos/…)` appended at end | Matches the markdown insert format |
| Concurrent edit | n/a | write refused if the file changed mid-flight | Same guard as Enhance |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/vaultImageInsert.ts` | 1-47 | The pick→write→rel core to extend with a camera source |
| P0 | `apps/mobile/src/lib/enhanceProse.ts` | 195-260 | **The** mtime-guard write pattern to mirror exactly |
| P0 | `apps/mobile/src/components/CardScannerModal.tsx` | 12-130 | Camera modal pattern: permissions, `CameraView`, `takePictureAsync` |
| P1 | `apps/mobile/src/lib/attachments.ts` | 23-76 | `PickedAttachment` shape + the size-cap guards to reuse |
| P1 | `apps/mobile/src/lib/useNoteEditSession.ts` | 200-243 | Existing insert handlers — in-flight ref + error pattern |
| P1 | `apps/mobile/src/lib/writer.ts` | 674-690 | `writeBinary` signature and collision-safe naming |
| P2 | `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | 60-130 | Permission gate copy + `quality: 0.6` rationale |
| P2 | `apps/mobile/src/lib/enhanceProse.test.ts` | 155-224 | Guard-case test structure to copy |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `expo-camera` | Already a dependency; see in-repo usage | Use `CameraView` + `useCameraPermissions`; do **not** add a new native module |

No external research needed beyond this — the feature composes established
internal patterns. **Do not add a dependency.** See Risks for why.

---

## Patterns to Mirror

### CAMERA_MODAL
```tsx
// SOURCE: apps/mobile/src/components/CardScannerModal.tsx:12,40-50,110-119
import { CameraView, useCameraPermissions } from "expo-camera";

const cameraRef = useRef<CameraView>(null);
const [permission, requestPermission] = useCameraPermissions();
// ...
const photo = await cameraRef.current.takePictureAsync({ /* opts */ });
// render:
!permission.granted ? (/* permission gate */) : (
  <CameraView ref={cameraRef} style={styles.camera} facing="back" />
)
```

### VAULT_IMAGE_WRITE
```ts
// SOURCE: apps/mobile/src/lib/vaultImageInsert.ts:30-47
const picked = await pickAttachment({ imagesOnly: true });
if (!picked) return null;
const ext = extFromMime(picked.mime);
const base = slugify(picked.filename.replace(/\.[^.]+$/, "")) || "image";
const { finalName } = await writeBinary("Photos", `${base}.${ext}`, picked.base64, picked.mime);
const rel = `../Photos/${finalName}`;
```

### MTIME_GUARDED_WRITE  ← the one that matters
```ts
// SOURCE: apps/mobile/src/lib/enhanceProse.ts:200,203,252
const baseline = await getModificationTime(input.filepath);
// ... slow work (camera, user framing the shot) ...
source = await readNote(input.filepath);          // CURRENT content, never the caller's snapshot
const written = await updateNoteIfUnchanged(input.filepath, next, baseline);
```

### IN_FLIGHT_GUARD_AND_ERROR
```ts
// SOURCE: apps/mobile/src/lib/useNoteEditSession.ts:206-222
if (insertingImageRef.current || savingEditRef.current) return;
insertingImageRef.current = true;
setEditError(null);
try { /* ... */ } catch (e: unknown) {
  setEditError(e instanceof Error ? e.message : String(e));
} finally { insertingImageRef.current = false; }
```

### TEST_STRUCTURE
```ts
// SOURCE: apps/mobile/src/lib/enhanceProse.test.ts:155-224
describe("enhanceNoteProse — disk freshness + write guard", () => {
  it("keeps the user's version when the note changed mid-flight", async () => { /* ... */ });
  it("captures the mtime baseline BEFORE the model call, not after", async () => { /* ... */ });
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/attachPhotoToNote.ts` | CREATE | View-mode disk write with the mtime guard; keeps logic out of the screen |
| `apps/mobile/src/lib/attachPhotoToNote.test.ts` | CREATE | Guard + append coverage |
| `apps/mobile/src/components/PhotoAttachModal.tsx` | CREATE | Camera modal with a Library fallback |
| `apps/mobile/src/lib/vaultImageInsert.ts` | UPDATE | Add `writeCapturedVaultImage(base64, mime)` beside the picker flow |
| `apps/mobile/src/lib/vaultImageInsert.test.ts` | UPDATE | Cover the captured-bytes path |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | `⋮` row + modal wiring |
| `apps/mobile/src/screens/RecentDetailScreen.test.tsx` | UPDATE | Menu row renders and dispatches |

## NOT Building

- **No changes to capture-time flows.** `PhotoCaptureScreen` and `CardScannerModal` stay untouched.
- **No camera button in the edit-mode toolbar.** Explicitly deferred (the earlier "both surfaces" option was declined). Edit mode keeps its library-only picker.
- **No new dependency.** `expo-camera` is already present.
- **No image editing** — no crop, rotate, filters, annotation.
- **No multi-shot / burst.** One photo per invocation.
- **No re-encoding or resizing** beyond the existing `quality: 0.6`.
- **No Karakeep code changes.** Incremental asset sync already pushes only new attachments (`karakeepAssetSync.ts`); a note with a `karakeepId` picks the photo up on its next export. Verify, do not modify.

---

## Step-by-Step Tasks

### Task 1: `writeCapturedVaultImage` in `vaultImageInsert.ts`
- **ACTION**: Add a sibling to `pickAndWriteVaultImage` that takes already-captured bytes instead of opening the picker.
- **IMPLEMENT**: `export async function writeCapturedVaultImage(base64: string, mime: string, basename?: string): Promise<VaultImageInsert>` — reuse the existing body from `extFromMime` onward; default `basename` to `photo`.
- **MIRROR**: VAULT_IMAGE_WRITE.
- **IMPORTS**: same module-local imports already at the top of the file.
- **GOTCHA**: The camera returns bytes directly, so the `MAX_SAFE_SHARE_BYTES` pre-check inside `pickAttachment` is bypassed. Re-apply the base64 cap check here or a 50 MP shot can OOM a low-RAM device — `PhotoCaptureScreen.tsx:121` documents that `quality: 0.6` controls compression, **not resolution**.
- **VALIDATE**: unit test writes to `Photos/` with a collision-safe name and returns `../Photos/<name>`.

### Task 2: `PhotoAttachModal` component
- **ACTION**: Create a modal exposing camera preview, shutter, a **Library** button, and a permission gate.
- **IMPLEMENT**: `onCaptured(base64: string, mime: string)` and `onPickedFromLibrary()` callbacks; `onDismiss`. Library path delegates to the existing `pickAndWriteVaultImage`.
- **MIRROR**: CAMERA_MODAL.
- **IMPORTS**: `import { CameraView, useCameraPermissions } from "expo-camera";`
- **GOTCHA**: `takePictureAsync` needs `{ base64: true }` to return bytes; without it you get a URI and must re-read the file. Match `PhotoCaptureScreen`'s permission-denied copy rather than inventing new wording.
- **VALIDATE**: renders the permission gate when `!permission.granted`; renders `CameraView` when granted.

### Task 3: `attachPhotoToNote` lib module
- **ACTION**: Create the view-mode write path.
- **IMPLEMENT**:
  ```ts
  export async function attachPhotoToNote(input: {
    filepath: string;
    base64: string;
    mime: string;
  }): Promise<{ kind: "attached"; rel: string } | { kind: "failed"; reason: string }>
  ```
  Order matters: capture the mtime **baseline first**, then write the binary, then `readNote` for CURRENT content, append `\n\n![](${rel})\n`, then `updateNoteIfUnchanged`.
- **MIRROR**: MTIME_GUARDED_WRITE.
- **IMPORTS**: `import { getModificationTime, readNote, updateNoteIfUnchanged } from "./writer";` — verified: exported at `writer.ts:706`, `:727`, `:758`, imported exactly this way at `enhanceProse.ts:21-25`.
- **GOTCHA**: **Never trust a caller-supplied body snapshot.** The screen's copy is stale from screen-load, and the camera step is a wide window for a Syncthing or Obsidian edit to land. This is the exact defect class #133 fixed and the `llm-rewrite-needs-mtime-guard` learning describes. Also: never throw — return a `failed` reason, matching `enhanceProse`'s never-throws contract.
- **VALIDATE**: a test that mutates the file between baseline and write asserts the user's version wins and nothing is clobbered.

### Task 4: Wire the `⋮` row in `RecentDetailScreen`
- **ACTION**: Add **Attach photo** below Enhance; open `PhotoAttachModal`; on result call `attachPhotoToNote`, then refresh the rendered note.
- **IMPLEMENT**: in-flight ref so a double-tap cannot double-attach; snackbar on success, error banner on failure.
- **MIRROR**: IN_FLIGHT_GUARD_AND_ERROR, and the existing Enhance row for menu-item shape and copy tone.
- **IMPORTS**: the new modal + lib module.
- **GOTCHA**: `RecentDetailScreen.tsx` is ~1614 lines and already over this repo's 800-line norm (CLAUDE.md calls it out by name). Put logic in `attachPhotoToNote.ts`; the screen gets wiring only. Do not grow inline logic here.
- **VALIDATE**: screen test asserts the row renders and dispatches.

### Task 5: Confirm Karakeep needs no change
- **ACTION**: Verify only — read `karakeepAssetSync.ts` and confirm a newly appended attachment is picked up by the existing incremental path.
- **IMPLEMENT**: nothing, unless the check fails.
- **GOTCHA**: If it does need a change, **stop and re-scope** — that was explicitly excluded here.
- **VALIDATE**: cite the function that enumerates attachments at export time and state why a new one is included.

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| writes captured bytes to Photos/ | base64 + `image/jpeg` | `../Photos/photo.jpg` | no |
| collision-safe naming | second write, same basename | `photo-2.jpg` (per `writeBinary`) | yes |
| oversize capture rejected | base64 over cap | throws the cap message, nothing written | yes |
| appends embed to body | note with frontmatter + body | `![](../Photos/…)` at end, frontmatter byte-intact | no |
| **mid-flight edit refused** | file mtime changes after baseline | `failed`, user's version preserved | yes |
| baseline captured before capture | — | `getModificationTime` called before the write | yes |
| never throws on write failure | `updateNoteIfUnchanged` rejects | returns `failed` with a reason | yes |
| permission denied | `granted: false` | gate renders, no camera mounted | yes |

### Edge Cases Checklist
- [ ] User cancels the camera — nothing written, no body change
- [ ] Permission denied, then granted on retry
- [ ] Note deleted while the camera is open
- [ ] Note edited in Obsidian mid-capture (the guard case)
- [ ] Oversize / high-resolution photo
- [ ] Note with no trailing newline
- [ ] Note that already contains attachments
- [ ] Double-tap the menu row

---

## Validation Commands

### Static Analysis
```bash
npm run build:shared && npm -w @carnet/mobile run typecheck
```
EXPECT: zero type errors

### Lint
```bash
npm -w @carnet/mobile run lint
```
EXPECT: clean. **Do not widen the three-rule ESLint config** (CLAUDE.md — scope was change-controlled).

### Unit Tests
```bash
npm -w @carnet/mobile test -- attachPhotoToNote vaultImageInsert
```
EXPECT: all pass

### Full Test Suite
```bash
npm -w @carnet/mobile test && npm -w @carnet/shared test
```
EXPECT: 1622+ mobile / 12 shared, no regressions

### Capture-flow Gate
```bash
npm -w @carnet/mobile run verify:capture-flow
```
EXPECT: 272/272 — proves the writer/frontmatter layer is untouched

### Native Verification
```bash
npm -w @carnet/mobile run android
```
EXPECT: builds. Only needed if a config plugin changes — it should not, since `expo-camera` is already wired.

### Manual Validation
- [ ] `⋮` → Attach photo → shutter → embed appears in the note
- [ ] Reopen the note: image renders inline (not a broken link)
- [ ] File exists at `Photos/<name>` in the vault
- [ ] Frontmatter byte-identical before/after
- [ ] Edit the note in Obsidian mid-capture → **both survive**: the embed is appended
      to your edited version, not to the stale screen copy. (The attach is NOT refused
      here — the framing window sits upstream of `attachPhotoToNote`, so the edit is
      already on disk when the baseline is taken and the fresh `readNote` picks it up.
      The mtime guard only refuses a write landing inside the much shorter
      write-image → overwrite span, which is not reproducible by hand.)
- [ ] Note already in Karakeep → re-export pushes only the new asset

---

## Acceptance Criteria
- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing, including the mid-flight guard case
- [ ] No type errors, no lint errors
- [ ] `⋮` row matches the existing menu's visual and copy conventions

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style (never-throws, reason strings)
- [ ] Tests follow the co-located `*.test.ts` pattern
- [ ] No hardcoded values
- [ ] `RecentDetailScreen.tsx` grew by wiring only, not logic
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Concurrent-edit clobber | Medium | **High** — silent data loss, the #133 class | Mandatory mtime guard; a test that fails without it |
| **New native dep can't build** | Low | **High** — build env cannot fetch uncached Gradle deps (`dl.google.com` TLS blocked); this already killed `react-native-keyboard-controller` | Use `expo-camera`, already present. Adding any native module blocks the build. |
| OOM on a high-res capture | Medium | High — uncatchable crash | Re-apply the base64 cap; `quality` does not limit resolution |
| `RecentDetailScreen` grows further | High | Medium | Logic in `attachPhotoToNote.ts`; screen gets wiring only |
| Orphaned file if the write is refused | Medium | Low | Same accepted tradeoff the existing insert handlers document — recoverable in the vault |

## Notes
- The `⋮`-menu surface was chosen over an edit-toolbar camera button; "both
  surfaces" was explicitly declined. Revisit only on request.
- This plan is the *second* framing. The first two attempts misread the gap
  (thinking notes couldn't gain attachments at all, then that the buttons were
  missing). The actual gap is narrow: **the picker is a file browser and cannot
  reach the camera.** Anyone extending this should keep that framing.
- Karakeep is verify-only. If verification shows a change is required, stop and
  re-scope rather than widening this plan.
