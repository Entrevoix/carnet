# Plan: Audio + arbitrary file share types

> ✅ SHIPPED 2026-06 (commit 8d3a6fe — ShareReceiveScreen audio + other-file branches; app.json intent filters text/image/audio/*). Archived for history.

## Summary
Extend the v0.2.1 share-target to accept audio (`audio/*`) and arbitrary file (`*/*`) MIME types in addition to the existing text/image handlers. The receiver screen already has all the writer machinery; this is mostly a manifest change + two new branches in `ShareReceiveScreen.save()` for audio and "other file" payloads.

## User Story
As a carnet user,
I want to share an audio file (recording app, podcast clip) or any other file (PDF, doc, anything) into carnet,
So that the same intake pipeline that handles images and URLs also captures my other media.

## Problem → Solution
**Current:** Sharing an audio file or a PDF to carnet does nothing — carnet only appears in the share sheet for `text/*` and `image/*` (per `app.json` plugin config). **Desired:** Carnet shows up for any share, accepts the file, writes the binary into the vault, and creates a stub markdown note with user-supplied context.

## Metadata
- **Complexity:** Small-to-Medium
- **Source PRD:** N/A
- **PRD Phase:** N/A
- **Estimated Files:** 3 modified

---

## UX Design

### Before
```
Other app → Share → (Carnet not in list because the file is audio/PDF)
```

### After
```
Other app → Share → Carnet (now visible for audio/*, application/*, anything)
  → ShareReceive card shows filename + mime + size
  → user adds optional voice/text context
  → Save
    audio  → Audio/{slug}.{ext} + Ideas/{slug}.md (kind: shared-audio)
    other  → Files/{slug}.{ext} + Ideas/{slug}.md (kind: shared-file)
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Share sheet visibility | text/image only | + audio + arbitrary | Manifest plugin change → native rebuild needed |
| ShareReceive payload card | image thumb OR URL/text | + audio (no thumb, show filename/size) + file (same) | Reuses existing `files` array rendering |
| Save target subdir | Photos/ (image), Ideas/ (text/url) | + Audio/, + Files/ | New subdirs created lazily via existing `findOrCreateSubdir` |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/app.json` | the plugins array | Where the share-intent plugin lives. Today: `"androidIntentFilters": ["text/*", "image/*"]` |
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | all (~300) | The save() branching for image vs url/text — model for adding audio + file branches |
| P0 | `apps/mobile/src/lib/writer.ts` | `writeBinary`, `extFromMime` | Already supports any subdir; mime→ext mapping already covers `audio/mpeg`, `audio/wav`, `audio/m4a`, `application/pdf` |
| P1 | `apps/mobile/src/lib/omniroute.ts` | `enrichSharedLink` shape | Audio share probably wants a text-only enrichment (filename + context) — same shape as link |
| P1 | `apps/mobile/src/lib/prompts.ts` | `buildSharedLinkPrompt` | Pattern for the prompt builder we may copy for audio/file |
| P1 | `apps/mobile/android/app/src/main/AndroidManifest.xml` | `<intent-filter action.SEND>` block | After prebuild, this is where the new mime types must appear |

## External Documentation
None. The `expo-share-intent` plugin docs are already in `node_modules/expo-share-intent/README.md` and we used them in v0.2.1.

---

## Patterns to Mirror

### ANDROID_INTENT_FILTERS_CONFIG
```json
// SOURCE: apps/mobile/app.json (plugins array)
[
  "expo-share-intent",
  {
    "androidIntentFilters": ["text/*", "image/*"]
  }
]
// → extend to ["text/*", "image/*", "audio/*", "*/*"]
// `*/*` MUST be last because Android matches in order;
// putting it first would shadow the more-specific entries
// and prevent the share sheet from showing carnet as a
// "media" target where it currently does.
```

### SHARED_LINK_PROMPT_SHAPE
```ts
// SOURCE: apps/mobile/src/lib/prompts.ts buildSharedLinkPrompt
export function buildSharedLinkPrompt(url: string, text: string, context: string): PromptPair {
  const system = `... (curator instructions) ... ${INJECTION_GUARD} ...
Respond ONLY with valid Obsidian markdown. Use this skeleton ...`;
  const bodyParts = [url, text, context].filter(Boolean).join("\n");
  const user = `<USER_INPUT>\n${bodyParts}\n</USER_INPUT>`;
  return { system, user };
}
```

### SAVE_BRANCH_PATTERN
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx save()
if (imageFile) { ... vision enrich + writeBinary("Photos") + writeIdea ... }
else if (url || text) { ... text enrich + writeIdea ... }
else { throw new Error("Nothing to save — empty share payload"); }
// → insert two new branches BEFORE the final throw:
//   else if (audioFile) { ... writeBinary("Audio") + writeIdea(stub) ... }
//   else if (otherFile) { ... writeBinary("Files") + writeIdea(stub) ... }
```

### BINARY_WRITE_PATTERN (already exists, reuse)
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx save() (image branch)
const base64 = imageFile.path.startsWith("content://")
  ? await StorageAccessFramework.readAsStringAsync(imageFile.path, { encoding: Base64 })
  : await FileSystem.readAsStringAsync(imageFile.path, { encoding: Base64 });
const ext = extFromMime(mime);
const { finalName } = await writeBinary(subdir, `${desiredSlug}.${ext}`, base64, mime);
const sharedStem = finalName.replace(/\.[^.]+$/, "");
const { filepath } = await writeIdea(sharedStem, mdNote);
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/app.json` | UPDATE | Extend `androidIntentFilters` to `["text/*", "image/*", "audio/*", "*/*"]`. |
| `apps/mobile/src/screens/ShareReceiveScreen.tsx` | UPDATE | Add audio + other-file branches to `save()`. Render audio/file payloads in the existing files-list card (no thumb). |
| `apps/mobile/src/lib/prompts.ts` | UPDATE | Optional — add `buildSharedFilePrompt(filename, mime, context)` if we want LLM titles for non-image shares. Otherwise reuse a stub. |
| `apps/mobile/src/lib/omniroute.ts` | UPDATE (maybe) | Optional — add `enrichSharedFile({ filename, mime, context })`. Could also just reuse `enrichSharedLink` with a synthetic "Source: {filename}" text input. |

## NOT Building
- **Audio transcription via Whisper / OmniRoute audio models.** Out of scope for this PR — too many model-specific quirks. Save the file + accept text/voice context; transcription is a follow-up.
- **Inline file preview / PDF rendering.** Carnet stays intake-only.
- **Filename sanitization beyond what `writeBinary` already does.** Trust the share intent's `fileName`.
- **Limit on total file size.** Audio + arbitrary files can be large but they're never sent to the vision model — only the binary write. SAF handles this fine.

---

## Step-by-Step Tasks

### Task 1: Extend `androidIntentFilters`
- **ACTION:** Edit `apps/mobile/app.json` to add `"audio/*"` and `"*/*"` to the share-intent plugin's `androidIntentFilters` array.
- **IMPLEMENT:** `"androidIntentFilters": ["text/*", "image/*", "audio/*", "*/*"]`
- **MIRROR:** `ANDROID_INTENT_FILTERS_CONFIG`.
- **GOTCHA:** Putting `*/*` first or middle changes the share-sheet ranking and can demote carnet for image shares. Put it last.
- **VALIDATE:** Run `cd apps/mobile && rm -rf android && npx expo prebuild --platform android && grep -c "android.intent.action.SEND" android/app/src/main/AndroidManifest.xml` — expect ≥1. Then inspect the `<intent-filter>` block and confirm 4 `<data android:mimeType=...>` lines.

### Task 2: Render audio + file payloads in the ShareReceive card
- **ACTION:** Existing rendering already handles `files.map` and shows a thumb only when `f.mimeType?.startsWith("image/")`. No change needed for audio/file display — the file row already shows filename + mime + size. Verify by reading lines that render `<View style={styles.fileRow}>`.
- **IMPLEMENT:** No-op confirmation; possibly add a small icon (audio note, document) next to non-image files to make the list scannable.
- **MIRROR:** Existing `<Image source={{ uri: f.path }} />` conditional in the files-list block of `ShareReceiveScreen.tsx`.
- **GOTCHA:** None — the existing UI is type-agnostic.
- **VALIDATE:** Share an MP3 → card shows filename + `audio/mpeg • XX KB`.

### Task 3: Add audio branch to `ShareReceiveScreen.save()`
- **ACTION:** In `save()`, after the image branch, before the `url || text` branch, detect `audioFile = files.find((f) => f.mimeType?.startsWith("audio/"))`. If present, read base64 (with the same content:// vs file:// branching as image), `writeBinary("Audio", ...)`, then write a stub markdown to `Ideas/`.
- **IMPLEMENT:** Markdown stub mirrors the existing degraded-image stub:
  ```
  ---
  created: <ISO>
  kind: shared-audio
  source: <fileName>
  mime: <mime>
  size: <bytes>
  tags: [shared, audio]
  ---
  # Shared audio: {fileName}

  ## File
  [{fileName}](../Audio/{finalName})

  ## Context
  {ctx || "(none provided)"}
  ```
  Use `slugify(fileName)` for the desiredSlug; share the bumped stem (like image branch).
- **MIRROR:** `SAVE_BRANCH_PATTERN`, `BINARY_WRITE_PATTERN`.
- **IMPORTS:** Already in scope.
- **GOTCHA:**
  - Don't call `enrichSharedImage` on audio bytes — model would reject `data:audio/...;base64,...`.
  - Optional task: call `enrichSharedLink({ url: "", text: fileName + ' • ' + mime, context })` to get an LLM-generated title. Decide during impl; default to a deterministic title to keep latency low.
- **VALIDATE:** Share an MP3 → file lands in `{vault}/Audio/{slug}.mp3`, MD in `{vault}/Ideas/{slug}.md` referencing it via `../Audio/`.

### Task 4: Add generic-file branch to `save()`
- **ACTION:** After the audio branch, add `otherFile = files.find((f) => !f.mimeType?.startsWith("image/") && !f.mimeType?.startsWith("audio/"))`. Same shape as audio branch but writes to `Files/` and uses `kind: shared-file`.
- **IMPLEMENT:** As task 3 but `Files/` subdir + `kind: shared-file` + tags `[shared, file]`.
- **MIRROR:** Task 3.
- **GOTCHA:** Some shares carry zero files but have text — the existing `url || text` branch still handles those, so don't move it.
- **VALIDATE:** Share a PDF from Drive → `Files/{slug}.pdf` + `Ideas/{slug}.md` with `kind: shared-file`.

### Task 5: Optional — add `buildSharedFilePrompt` for LLM title
- **ACTION:** If during testing the deterministic title feels too sparse, add a prompt builder in `prompts.ts` that takes `filename + mime + context` and returns a title/tags-only enrichment via `chatCompletion`. Hook it into the new branches.
- **IMPLEMENT:** ~30 line addition mirroring `buildSharedLinkPrompt`.
- **MIRROR:** `SHARED_LINK_PROMPT_SHAPE`.
- **GOTCHA:** Defer unless needed. Latency and degraded-banner story already exists.
- **VALIDATE:** Title in MD is descriptive (not just the filename).

### Task 6: Native rebuild and on-device validation
- **ACTION:** `rm -rf apps/mobile/android && cd apps/mobile && npx expo prebuild --platform android && npx expo run:android` to regen manifest + rebuild + install.
- **MIRROR:** Same sequence as the v0.2.1 share-target merge.
- **GOTCHA:** Skipping `prebuild` will reuse the old manifest and the new intent filters won't take effect.
- **VALIDATE:** Confirm via Android share sheet — carnet appears for an MP3 (gallery/music app), for a PDF (Files app), for an APK (browser download), etc.

---

## Testing Strategy

### Unit Tests
The save branching is hard to unit-test without RN Testing Library (depends on the share intent provider). Rely on:
- `extFromMime` already tests audio/* and application/pdf cases (added in v0.2.1).
- Manual share-and-verify on device.

### Edge Cases Checklist
- [ ] MP3 share → Audio/{slug}.mp3 + Ideas/{slug}.md
- [ ] M4A share (iOS-style) → Audio/{slug}.m4a
- [ ] PDF share → Files/{slug}.pdf
- [ ] APK / .zip / unknown binary → Files/{slug}.bin (extFromMime falls back to bin)
- [ ] Multiple files in one share (rare on Android) → save the FIRST audio file or FIRST other file; don't multi-save (matches image behavior today)
- [ ] No mime type on share → defaults to "application/octet-stream" → ext "octet-stream" → wrong but harmless

---

## Validation Commands

```bash
# After app.json edit, before rebuild:
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test

# Regen native + verify manifest:
cd apps/mobile && rm -rf android && npx expo prebuild --platform android
grep -A 8 "android.intent.action.SEND" android/app/src/main/AndroidManifest.xml
# EXPECT: data lines for text/*, image/*, audio/*, */*

# Build + install:
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk PATH="/home/user/Android/Sdk/platform-tools:$PATH" npx expo run:android
```

### Manual Validation
- [ ] Open Files app → share PDF → Carnet visible → save → file in vault
- [ ] Open music app → share audio → Carnet visible → save → file in vault
- [ ] Existing image + URL/text shares still work (regression check)

---

## Acceptance Criteria
- [ ] Carnet appears in share sheet for audio/* shares
- [ ] Carnet appears for `*/*` (arbitrary) shares (anything not matched by more specific filters)
- [ ] Audio binary lands in `Audio/`, generic file in `Files/`
- [ ] MD note in `Ideas/` references the binary via relative path
- [ ] No regression in image / text / URL shares

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `*/*` filter demotes carnet in the image-share ranking on some launchers | Low | Mild UX hit | Filter order: `*/*` last |
| Large audio file (hour-long recording) → slow base64 read → app appears hung | Medium | Confusing | Show "Reading file…" copy in the saving phase; consider a size cap warning at, say, 50 MB |
| Some shared files arrive without a `fileName` (just a content:// URI) | Medium | Stub note title looks ugly | Fall back to `shared-file-{timestampSlug}` |

## Notes
- Audio transcription via OmniRoute (Whisper-family models) is the natural follow-up; this PR explicitly defers it.
- The `*/*` filter is intentionally broad. If we ever want to *exclude* specific types (e.g., `inode/directory`), we'd have to add an opposite filter — Android doesn't natively support exclusion.
