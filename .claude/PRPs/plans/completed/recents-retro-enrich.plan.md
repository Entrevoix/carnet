# Plan: Retro-enrich from RecentDetail (slate #5, image-based scope)

## Summary
Add a "Re-enrich" button to `RecentDetail` for notes whose `kind:` is `shared-image` or `photo`. Reads the note's frontmatter, locates the paired image in `Photos/`, re-runs `enrichSharedImage` against the bytes, and overwrites the .md body via `updateNote`. Mirrors the existing `reEnrichSaved` flows in `PhotoCaptureScreen` and `ShareReceiveScreen` — but available DAYS later from the recents list, not just immediately after capture. Link / text re-enrich is deferred (requires a one-line frontmatter migration first).

## User Story
As a carnet user,
I want to re-run vision enrichment on a photo I captured days ago whose first-pass result was a stub (the LLM endpoint was unreachable at capture time),
So that I can recover a properly-titled note without re-photographing the subject.

## Problem → Solution
**Current:** When a photo or share-image enrichment falls back to a stub (LLM offline, auth expired, VPN dropped), the user gets a "Re-enrich" button — but ONLY on the saved-phase screen, in the same session. Closing the screen loses the state. Days later, the stub note is stuck unless the user re-captures the photo.

**Desired:** Tap a recent → RecentDetail. If the note is image-backed (`kind: shared-image` or `kind: photo`) AND the paired image is still on disk, show a "Re-enrich" button. Tapping it re-reads the image bytes, calls `enrichSharedImage` against `ctx = ""` (no user context available), shows an in-flight indicator, then overwrites the .md body via `updateNote`. On failure, surface the error in a banner — don't destroy the existing body.

## Metadata
- **Complexity:** Small (1-PR; builds on existing helpers + the just-shipped recents screen)
- **Source PRD:** N/A — slate item #5 from `.claude/PRPs/plans/completed/recents-screen-preview-delete.plan.md` Notes
- **PRD Phase:** v0.3
- **Estimated Files:** 2 modified + 1 new (helpers) + tests

---

## UX Design

### Before
```
RecentDetail screen:
┌─────────────────────────────────┐
│ Shared image: photo-20260520    │
│ Photo · 5 days ago              │
│ /vault/Ideas/photo-20260520.md  │
│                                 │
│ ## What's in this               │
│ (Vision enrichment unavailable) │
│                                 │
│ ## Context                      │
│ (none provided)                 │
│                                 │
│ [🗑 Delete]                     │
└─────────────────────────────────┘
```

### After
```
RecentDetail screen (image-backed kinds):
┌─────────────────────────────────┐
│ Shared image: photo-20260520    │
│ Photo · 5 days ago              │
│ /vault/Ideas/photo-20260520.md  │
│                                 │
│ ## What's in this               │
│ A pizza recipe handwritten…     │  ← LLM-generated body
│                                 │
│ ## Context                      │
│ (none provided)                 │
│                                 │
│ [🗑 Delete]  [✨ Re-enrich]     │
└─────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Re-enrich button on RecentDetail | absent | shown when `kind` ∈ {`shared-image`, `photo`} AND paired binary resolvable | hidden for other kinds; no button = no false promise |
| Tap Re-enrich | — | ActivityIndicator overlay → `enrichSharedImage(base64, mime, "")` → `updateNote(filepath, newMarkdown)` → re-fetch + re-render body | failure shows banner; existing body kept |
| Body refresh | — | body state in screen updated after success | no nav change |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | 1-260 | Where the new button mounts; mirror the existing `IN_FLIGHT_GUARD` (deletingRef) pattern for `reEnrichingRef` |
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | 374-413 | The existing `reEnrichSaved` flow; we generalize it. Differs because it has `saveSource` in state — we have to derive everything from the .md on disk |
| P0 | `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | 220-250, 305-330 | Parallel `reEnrichSaved` flow + the photo image embed convention (`../Photos/{name}.jpg`) |
| P0 | `apps/mobile/src/lib/writer.ts` | 354-380 | `extractFrontmatterField` (currently private — promote to export); `stripFrontmatter` (already exported per PR #8) |
| P0 | `apps/mobile/src/lib/omniroute.ts` | 370-413 | `enrichSharedImage` signature: `({base64, mimeType, context}) → {markdown}` |
| P0 | `apps/mobile/src/lib/writer.ts` | 252-261 | `injectImageEmbed` — used after enrichment to put the `![](../Photos/X)` back |
| P1 | `apps/mobile/src/lib/writer.ts` | 219-261 | `readBinaryByUri` + path-detection regex from `moveToArchive` (similar regex used here for finding the paired image) |
| P1 | `apps/mobile/src/lib/shareHelpers.ts` | all | `MAX_SHARED_IMAGE_BYTES` import; `readShareFileAsBase64` is the right helper… wait, it's RN-specific and the paired image already lives in the vault on a file:// or content:// path — we need the writer-side helper instead |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Existing reEnrich (in-session) | `PhotoCaptureScreen.tsx:222`, `ShareReceiveScreen.tsx:377` | Reads `saveSource` from React state; calls enrich; calls `updateNote` |
| Frontmatter field read | `writer.ts:354` (private `extractFrontmatterField`) | Promote to export; reuse for parsing `kind:` |
| Body strip | `writer.ts:373` (`stripFrontmatter`) | Already exported by PR #8 |
| Paired-image link regex | `writer.ts:~648` (`moveToArchive`) | `/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/` — same regex to find the paired image path |
| Image embed injection | `writer.ts:252` (`injectImageEmbed`) | Put `![](../Photos/X)` after the new H1 |
| Binary read (vault-side) | `writer.ts:~243` (`readBinaryByUri`) | Returns base64; handles SAF + file://. Currently private — promote to export OR add a public wrapper `readVaultBinary(filepath)` that takes a vault filepath and figures out SAF-ness internally |
| Size limit | `omniroute.ts` `MAX_SHARED_IMAGE_BYTES` + `assertBase64UnderLimit` | Already used by image branches; reuse for re-enrich |

---

## Patterns to Mirror

### REENRICH_SAVED_PATTERN (existing in PhotoCaptureScreen)
```ts
// SOURCE: apps/mobile/src/screens/PhotoCaptureScreen.tsx:222-250
const reEnrichSaved = async (): Promise<void> => {
  if (!savedFilepath || !rawBase64 || !rawMime) return;
  if (savingRef.current) return;
  savingRef.current = true;
  setError(null);
  setPhase("saving");
  try {
    const result = await enrichSharedImage({
      base64: rawBase64,
      mimeType: rawMime,
      context: ctx,
    });
    const withImage = injectImageEmbed(
      result.markdown,
      `../Photos/${savedImageName}`,
    );
    await updateNote(savedFilepath, withImage);
    setDegradedReason(null);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[PhotoCapture] re-enrich failed:", reason);
    setDegradedReason(reason);
  } finally {
    savingRef.current = false;
    setPhase("saved");
  }
};
```

For RecentDetail we DON'T have `rawBase64` in state — we have to read it back from disk. New shape:

```ts
const reEnrichSaved = async (): Promise<void> => {
  if (reEnrichingRef.current) return;
  reEnrichingRef.current = true;
  setReEnrichError(null);
  setReEnriching(true);
  try {
    // 1. Find paired image
    const linkMatch = body.match(/\.\.\/Photos\/([^/\s)]+)/);
    if (!linkMatch) throw new Error("No paired image found in this note.");
    const imageFilename = linkMatch[1];
    const photosUri = await findOrCreateSubdir(root, "Photos"); // need root...
    // ... actually easier: use a new public helper readPairedBinary(notePath) that does all this
    const { base64, mime } = await readPairedBinary(entry.filepath);
    // 2. Enrich
    const result = await enrichSharedImage({ base64, mimeType: mime, context: "" });
    // 3. Re-inject image link
    const withImage = injectImageEmbed(result.markdown, `../Photos/${imageFilename}`);
    // 4. Save
    await updateNote(entry.filepath, withImage);
    setBody(withImage);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    setReEnrichError(reason);
  } finally {
    reEnrichingRef.current = false;
    setReEnriching(false);
  }
};
```

Conclusion: encapsulate the "find + read paired binary from a note's body" as a new exported helper `readPairedBinaryFromNote(filepath, body)` in `writer.ts` — keeps the screen clean, reuses the regex + readBinaryByUri private helpers, and tests cleanly.

### FRONTMATTER_KIND_ROUTING
```ts
// In RecentDetailScreen, after loading body:
const kind = extractFrontmatterField(body, "kind") ?? "";
const canReEnrich = kind === "shared-image" || kind === "photo";
```

### NEW_HELPER_SHAPE (writer.ts)
```ts
/** Locate and read the paired binary for a note (e.g. the JPEG behind a
 * photo/shared-image .md), returning {base64, mime}. Throws if the note's
 * body doesn't reference a paired binary or the target file doesn't exist
 * in the expected subdir. mime is derived from the file extension via the
 * inverse of extFromMime. */
export async function readPairedBinaryFromNote(
  filepath: string,
  body: string,
): Promise<{ base64: string; mime: string }> {
  const linkMatch = body.match(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/);
  if (!linkMatch) throw new Error("No paired binary link found in note.");
  const subdir = linkMatch[1];
  const filename = linkMatch[2];
  const root = await resolveRoot();
  const subdirUri = await findOrCreateSubdir(root, subdir);
  const binaryUri = await findFileInDir(subdirUri, filename, root.isSaf);
  if (!binaryUri) throw new Error(`Paired binary not found: ${subdir}/${filename}`);
  const base64 = await readBinaryByUri(binaryUri, root.isSaf);
  const mime = mimeFromFilename(filename);
  return { base64, mime };
}

/** Tiny inverse of extFromMime — best-effort, falls back to octet-stream. */
function mimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", webp: "image/webp",
    gif: "image/gif", heic: "image/heic", heif: "image/heif",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/writer.ts` | UPDATE | Add `readPairedBinaryFromNote` + `mimeFromFilename`; promote `extractFrontmatterField` to exported |
| `apps/mobile/src/lib/writer.test.ts` | UPDATE | Tests for the 2 new public helpers |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | Add Re-enrich button gated on kind; wire `reEnrichSaved`; show in-flight indicator + error banner |
| (no new files) | — | The helper is small enough to live in writer.ts |

## NOT Building
- **Link / text re-enrich** — needs a frontmatter `source:` migration in `ShareReceiveScreen` first. Documented as a follow-up.
- **Audio re-transcription** — slate item depending on Whisper-via-OmniRoute path. Out of scope.
- **Generic-file LLM titling** — same dependency.
- **Idea / journal / person re-enrich** — raw input not recoverable; the enriched body IS the only artifact. Not a meaningful operation.
- **User context input on re-enrich** — first-pass re-enrich uses `context: ""`. A "let me add context before re-enrich" flow is a follow-up.
- **Diff / preview before overwrite** — would be nice ("show me what changes"), out of scope.
- **Undo** — once `updateNote` runs, the old body is gone. User can soft-delete + re-capture. Acceptable for v0.3.
- **Bulk re-enrich** — operate on one note at a time.

---

## Step-by-Step Tasks

### Task 1: Promote `extractFrontmatterField` to exported + add `readPairedBinaryFromNote` + `mimeFromFilename` in writer.ts
- **ACTION:** Edit `apps/mobile/src/lib/writer.ts`. Change `function extractFrontmatterField` → `export function extractFrontmatterField`. Append the two new helpers per `NEW_HELPER_SHAPE`.
- **IMPLEMENT:** see snippet above.
- **MIRROR:** existing private writer helpers (`findFileInDir`, `readBinaryByUri`). The new public helper composes them.
- **IMPORTS:** all internal.
- **GOTCHA:**
  - `findFileInDir` returns null on the file:// branch when the file doesn't exist — handle with a friendly error message; don't propagate a stack trace to the user.
  - `mimeFromFilename` is intentionally tiny + permissive. If the user's vault holds a heic image, we map to `image/heic` — but `enrichSharedImage` may not accept heic depending on the OmniRoute model. That's an existing risk (not introduced by this PR).
- **VALIDATE:** Task 2 tests.

### Task 2: Tests for `readPairedBinaryFromNote` + `mimeFromFilename`
- **ACTION:** Extend `apps/mobile/src/lib/writer.test.ts`.
- **IMPLEMENT:**
  ```ts
  describe("mimeFromFilename", () => {
    it("maps common image extensions", () => { ... });
    it("maps audio extensions", () => { ... });
    it("falls back to octet-stream for unknown", () => { ... });
    it("is case-insensitive", () => { ... });
  });
  
  describe("readPairedBinaryFromNote", () => {
    beforeEach(clearFiles);
    it("finds and returns the binary for a photo note", async () => {
      await writeBinary("Photos", "shot.jpg", "AAAA", "image/jpeg");
      const md = "# T\n\n![](../Photos/shot.jpg)\n";
      const { filepath } = await writeIdea("paired", md);
      const result = await readPairedBinaryFromNote(filepath, md);
      expect(result.base64).toBe("AAAA");
      expect(result.mime).toBe("image/jpeg");
    });
    it("throws when no link is in the body", async () => { ... });
    it("throws when the link target doesn't exist on disk", async () => { ... });
  });
  ```
- **VALIDATE:** `npm -w @carnet/mobile run test`.

### Task 3: Wire Re-enrich button into RecentDetailScreen
- **ACTION:** Edit `apps/mobile/src/screens/RecentDetailScreen.tsx`. Add `reEnrichingRef`, `reEnriching` state, `reEnrichError` state, `kind` derived from body. Render the button in the action card when `canReEnrich` is true.
- **IMPLEMENT:**
  - State: `const [reEnriching, setReEnriching] = useState(false); const [reEnrichError, setReEnrichError] = useState<string | null>(null); const reEnrichingRef = useRef(false);`
  - Derived: `const kind = extractFrontmatterField(body, "kind") ?? ""; const canReEnrich = kind === "shared-image" || kind === "photo";`
  - Handler `handleReEnrich` per the snippet in `REENRICH_SAVED_PATTERN` (above), reads the paired binary via `readPairedBinaryFromNote`, calls `enrichSharedImage`, injects the image embed, updates the note, updates local body state, surfaces the error.
  - Render: in the existing action `Card.Actions`, add a second `Button` with `icon="auto-fix"` (Paper's MaterialCommunityIcons name for sparkles) labeled "Re-enrich", `disabled={missing || reEnriching || !canReEnrich}`, `onPress={handleReEnrich}`. Hide entirely when `!canReEnrich`.
  - Render an in-flight ActivityIndicator above the body card while `reEnriching` is true. Surface `reEnrichError` in a Paper Banner above the body card.
- **MIRROR:** `IN_FLIGHT_GUARD` already used for `deletingRef`; same shape.
- **IMPORTS:** add `extractFrontmatterField`, `readPairedBinaryFromNote`, `injectImageEmbed`, `updateNote` from `../lib/writer`; `enrichSharedImage` from `../lib/omniroute`.
- **GOTCHA:**
  - After successful re-enrich, the body state must update OR the Markdown render won't reflect the new content. Set `setBody(withImage)` after `updateNote`.
  - The Re-enrich button is hidden — NOT shown-disabled — when `!canReEnrich`, to keep the action area uncluttered for unsupported kinds.
  - If the user backs out mid-flight: the `reEnrichingRef` prevents a second handler; `updateNote` either ran or didn't, but the screen unmounts cleanly.
- **VALIDATE:** Manual flow.

### Task 4: Validation
- `npm -w @carnet/mobile run typecheck` — clean
- `npm -w @carnet/mobile run test` — expect prior 114 + ~7 new (4 mimeFromFilename + 3 readPairedBinaryFromNote) = ~121 passing

### Task 5: On-device manual walk
- Capture a Photo with a stub fallback (disconnect OmniRoute first, capture, reconnect) → tap from recents → Re-enrich button visible → tap → body updates with LLM content
- Share an image with a stub fallback → tap from recents → Re-enrich behaves the same
- Tap a non-image recent (Idea / Journal / Contact / shared-link / shared-audio / shared-file) → no Re-enrich button
- Re-enrich after archive (theoretical): tap Delete → file moves to Archive → screen pops → fine
- Re-enrich when OmniRoute is unreachable → error banner above body; existing body preserved

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| `mimeFromFilename` jpg/png/webp/gif/heic/heif | filenames | correct image mime | no |
| `mimeFromFilename` mp3/wav/m4a | filenames | correct audio mime | no |
| `mimeFromFilename` pdf | filename | `application/pdf` | no |
| `mimeFromFilename` unknown extension | `foo.xyz` | `application/octet-stream` | yes |
| `mimeFromFilename` no extension | `foo` | `application/octet-stream` | yes |
| `mimeFromFilename` uppercase | `IMG.JPG` | `image/jpeg` | yes |
| `readPairedBinaryFromNote` happy path image | note with `../Photos/X.jpg` link + binary on disk | `{base64, mime: "image/jpeg"}` | no |
| `readPairedBinaryFromNote` no link in body | note without link | throws "No paired binary link found" | yes |
| `readPairedBinaryFromNote` link points to missing file | note links to ghost.jpg | throws "Paired binary not found" | yes |

### Edge Cases Checklist
- [ ] Photo note with broken link → friendly error, body unchanged
- [ ] Re-enrich during a network drop → error banner, body unchanged
- [ ] User taps Re-enrich twice rapidly → second tap no-op via `reEnrichingRef`
- [ ] Note exists but `kind:` is missing → button hidden (canReEnrich = false)
- [ ] Note has `kind: shared-image` but no link in body → friendly error
- [ ] HEIC image → enrichSharedImage may reject; surfaced as banner

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```

### On-device
```bash
ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk \
  PATH="/home/user/Android/Sdk/platform-tools:$PATH" \
  npx expo run:android
```
(No prebuild needed — pure JS change.)

### Manual Validation
- [ ] Capture a Photo while OmniRoute is reachable → tap from recents → Re-enrich appears → tap → new body renders (LLM ran twice; second run wins)
- [ ] Capture a Photo while OmniRoute is unreachable (force stub) → tap from recents → Re-enrich → succeeds once OmniRoute is back; body now has LLM content
- [ ] Share an image with stub fallback → re-enrich from recents → same
- [ ] Tap an Idea / Journal / Contact recent → NO Re-enrich button
- [ ] Tap a shared-link or shared-audio recent → NO Re-enrich button (link / audio re-enrich out of scope this PR)
- [ ] Re-enrich, OmniRoute returns an error → banner shows error; body unchanged
- [ ] Re-enrich, paired image renamed externally → "Paired binary not found" banner; body unchanged
- [ ] Re-enrich, then Delete → archive includes the updated .md (since `updateNote` ran first)

---

## Acceptance Criteria
- [ ] Re-enrich button appears only when `kind` ∈ {`shared-image`, `photo`} AND the body has a parseable `../Photos/X` link
- [ ] Tapping re-runs `enrichSharedImage` and overwrites the .md body via `updateNote`
- [ ] Body re-renders in the screen without a navigation pop
- [ ] Failures show a banner; existing body preserved
- [ ] No regression in Delete, missing-file banner, or any other RecentDetail flow
- [ ] `typecheck` clean; ~121/121 tests pass

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User's OmniRoute model returns a different markdown shape on re-enrich than first-pass, breaking the `injectImageEmbed` H1 detection | Low | Embed lands at the top of the file instead of under the H1 | `injectImageEmbed` already has the prepend fallback. Acceptable. |
| `mimeFromFilename` returns the wrong mime for a vendor-specific image extension | Low | OmniRoute rejects the upload | Surface the model error in the banner — user sees what happened |
| Re-enrich runs while user is also archiving (race) | Very Low | `updateNote` then `moveToArchive` — both succeed, archive moves the NEW body | Acceptable; user got fresh enrichment AND archived it intentionally |
| Notes WITHOUT frontmatter (older captures from pre-v0.2) | Low | `extractFrontmatterField` returns null → `canReEnrich = false` | Re-enrich button hidden; user can still Delete |
| User expects re-enrich to USE THE EXISTING BODY as context | Medium | `context: ""` passed; LLM has no continuity with prior result | Document on the button label / tooltip in a follow-up if real users complain |

## Notes
- Follow-up #1 (post-merge): store `source: <url>` and `text: <excerpt>` in shared-link / shared-text frontmatter at save time so link re-enrich becomes possible for NEW notes (existing notes can't be migrated retroactively).
- Follow-up #2: when slate #4 (native audio recording) lands and adds Whisper-via-OmniRoute, extend the same Re-enrich button to `kind: shared-audio` and `kind: voice-note`.
- Follow-up #3: "Add context before re-enrich" — pre-populate a TextInput from the saved `## Context` section and pass it to enrichSharedImage. Small lift.
