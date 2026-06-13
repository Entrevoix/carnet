# Handoff: WYSIWYG picture insert — BUILT, CI-green, on-device smoke PASSED

> ✅ Handoff for picture insert — SHIPPED (#42 67a254d, on-device smoke passed). Follow-up #43 (large images + save hardening) also shipped (#45). Archived snapshot.

> Status as of 2026-06-12. Branch `feat/wysiwyg-picture-insert` → PR #42 (off `main` @ `0fb7d1c`,
> commit `a7adae4`). tsc clean, 482/482 vitest, editor bundle rebuilt. **On-device smoke PASSED
> 2026-06-12 (Pixel 9 Pro Fold `4A111FDKD0000C`, the #42 release APK).** This doc bridges a `/clear`.

## ✅ On-device smoke — PASSED (2026-06-12)
Run on the disposable "Jack's Baseball Team" Idea note (already carried one image embed).
- **Data-URI display works under GrapheneOS/Vanadium** — the make-or-break unknown. A freshly
  picked image inserted via the toolbar button rendered inline in the editor. ✓
- **Insert flow** — image button → DocumentsUI `image/*` picker → pick → image appears in-editor. ✓
- **Save → canonical links, NO blob** — after Save, reopening the note showed BOTH images in the
  read-only Attachments card (which only resolves `../Photos/...` links), and the body was clean
  prose with no base64. So the saved `.md` carries `![](../Photos/x)`, not a `data:` URI. ✓
- **Existing image preserved** — the pre-existing baseball photo survived the round-trip (still in
  Attachments after save). ✓
- **Re-edit preview** — on re-entering edit, the now-saved (under-cap) image previewed inline. ✓
- **Discard guard** — Cancel on a dirty rich edit shows the discard dialog. ✓
- ⚠️ **One caveat (not a blocker):** the pre-existing baseball photo did NOT preview *in-editor*
  (the fresh insert and the smaller saved image both did). Most likely it's over the
  `MAX_EDITOR_IMAGE_BASE64` = 8 MB inline cap (`resolvePhotoDataUri` returns null → left canonical →
  no preview), or its on-disk embed didn't match `PHOTO_EMBED`. Either way it is **safely preserved
  on save** — no data loss, no corruption. Consider raising the cap (perf/DOM tradeoff) if large
  existing images should preview. Couldn't confirm the exact cause: the vault is the private app
  sandbox (`/data/user/0/com.ventoux.carnet/...`), unreadable on a release build (run-as denied).
- **QA note:** the test added a second image to "Jack's Baseball Team" (disposable note, syncs via
  Syncthing). Safe to delete the note or remove that image.

## ❌ Cap-raise attempt (2026-06-12) — REVERTED, do not retry naively
Tried raising `MAX_EDITOR_IMAGE_BASE64` 8 MB → 24 MB so the large baseball photo would preview.
**On-device it broke the editor:** with the photo now under the cap it resolved to a ~10 MB+ data
URI, and folding that into the single `setMarkdown` bridge string **silently failed to apply** — the
editor opened BLANK ("Write something …"). That's worse than no-preview: a Save on the blank editor
would write back an empty body (the `bodyInjectedRef` guard only catches save-*before*-injection,
not a silent injection failure). Reverted to 8 MB (commit after `dfa374d` → `eeed1cf`). The 8 MB cap
isn't just DOM cost — it bounds the bridge payload so injection stays reliable.
- **To actually preview large images** needs an architectural change, not a bigger constant: inject
  the body with canonical `../Photos/` links first (small, fast `setMarkdown`), THEN swap each image
  to its data URI via its own bounded message; or a `file://` access path (`allowingReadAccessToURL`).
- **Related robustness gap to consider:** harden the save path against a silently-empty editor
  (confirm the editor actually holds content — e.g. a length ack — before `updateNote`), so a failed
  injection can never blank a note. Worth a follow-up independent of the cap.

## TL;DR — what shipped (code-complete, behind on-device verification)
Image insert for the **default WYSIWYG editor** (the markdown-`TextInput` path already
had it; the rich editor had none). The crux was display + round-trip safety, not the
picker (picker/copy plumbing already existed).

- **Display:** the editor WebView loads at `https://localhost/`, so `![](../Photos/x.jpg)`
  can't resolve. On edit entry we swap each `../Photos/...` embed for an inline `data:`
  URI; the canonical relative path rides in the markdown **title** slot.
- **Round-trip safety:** `getMarkdown()` serializes whatever `src` the node holds, so a
  data URI left in would write a multi-MB base64 blob into the `.md`. On save we rebuild
  `![alt](../Photos/...)` from the title and **discard the returned src entirely** — only
  the short alt+title need survive the editor round-trip, not the giant base64.
- **Enforced postcondition:** a 3rd catch-all pass drops ANY embed that still carries a
  `data:<mime>/` URI, so "no base64 blob ever reaches disk" holds even if the serializer
  escapes the title, mangles the src, or emits a hostile alt. Asserted directly in tests.

## Files
- `src/lib/editorImages.ts` (NEW, pure) — `resolveImagesForEditor` / `restoreImagesFromEditor`
  (+ `toDataUri`, `buildEditorImage`, `buildCanonicalImage`, `MAX_EDITOR_IMAGE_BASE64=8MB`).
  22 unit tests in `editorImages.test.ts` (happy path, hostile alt, whitespace/newline in
  payload, two-on-a-line, idempotency, and a `not.toContain("data:")` postcondition sweep).
- `src/lib/photoDataUri.ts` (NEW, impure thin) — rel `../Photos/x` → `resolvePairedUri` →
  base64 read (file:// + SAF branches) → data URI; null when missing or over the 8MB cap.
- `src/bridges/MarkdownBridge.ts` — new `insert-markdown` message + web-side `insertContent`
  + RN-side `insertMarkdown`. **This is the only editor-web change → drove the bundle rebuild.**
- `src/components/WysiwygEditor.tsx` — resolve `value` before inject; restore in `getMarkdown`;
  `insertImage(rel, dataUri|null)` ref method; session `data:`→`rel` fallback map; two-gate
  one-shot injection (`loadedRef` + `resolvedRef`); `bodyInjectedRef` guard so a Save during
  cold-start can't pull the empty seed and blank the note.
- `src/screens/RecentDetailScreen.tsx` — image `IconButton` (`image-plus`) in the rich-edit
  bar → `insertWysiwygImage`: pick → `writeBinary("Photos", …)` → build data URI from the
  picked bytes (no disk re-read) → `wysiwygRef.insertImage`. Over-cap images insert canonical
  (no in-editor preview) but still save + render in the read-only detail view.
- `editor-web/generated/editorHtml.js` — rebaked by `npm run editor:build` (carries the bridge change).

## Verified WITHOUT the device
- `npx tsc --noEmit` clean; `npm test` 482/482 (was 460/477; +22 editorImages, net).
- `npm run editor:build` succeeds; bundle re-baked.
- Independent opus code-review (ran the REAL `marked@17` + `@tiptap/extension-image`
  serializer): design sound; insert path **provably** corruption-safe (`slugify` →
  `[a-z0-9-]` filenames can't carry regex-hostile chars); H1/H2 (blob-leak edge cases) and
  M3 (too-early-Save blank) were FIXED in this branch via the catch-all pass + the
  `bodyInjectedRef` guard.

## ⛔ On-device smoke — THE gating unknowns (need the Pixel, ~10 min)
The data-URI-in-WebView render and the title round-trip can ONLY be confirmed on-device
(GrapheneOS/Vanadium WebView; release build = no devtools). Build + install:
`cd apps/mobile && ANDROID_SERIAL=<serial> ANDROID_HOME=/home/user/Android/Sdk npm run android:release`

1. **Existing image renders in-editor.** Open a note that already has `![](../Photos/x.jpg)`
   → Edit → the image shows inline in the WYSIWYG editor (not a broken icon).
2. **Insert from picker.** Tap the new image button (top-right of the rich-edit bar) → pick
   an image → it appears at the cursor in-editor.
3. **Save → canonical link on disk.** Save, then check the `.md` (Obsidian / `adb`): body has
   `![](../Photos/<file>)` — **NOT** a `data:` blob. The file is in `Photos/`.
4. **Read-only view still renders it** (the Attachments card resolves `../Photos/...` natively).
5. **No-churn round-trip.** Open a note with an image, Save WITHOUT editing → the `.md` is
   unchanged (the `next === body` short-circuit holds; empty-alt embeds are byte-stable).
6. **Too-early Save** (optional): tap Save the instant the editor opens, before content
   appears → expect a "still loading" banner, NOT a blanked note.

If #1 fails (data URI won't render under Vanadium), the fallback is an absolute `file://`
src with `allowingReadAccessToURL` — but data-URI was chosen as the origin-robust path;
prove #1 before considering that.

## Known/accepted limitations
- A pre-existing Photos embed that already carries a markdown **title** (a user caption)
  is left canonical → shows broken in-editor for that session (never corrupt). Documented
  in `editorImages.ts`.
- `imageMapRef` holds `data:`→`rel` for the edit session (the fallback recovery map); not
  pruned on in-editor delete. Bounded by the 8MB/image cap + per-note scope.

## Not yet done
- **Commit + PR** (not committed; user hasn't asked). Suggested title:
  `feat: insert pictures in the WYSIWYG editor (data-URI display, relative-link round-trip)`.
- On-device smoke above.
- Other WYSIWYG loose ends still open: editor-ready ack (MEDIUM-4), CSP `<meta>` (LOW-4) —
  see `wysiwyg-native-editor-status-handoff.md`.

## Side note
claude-mem 13.5.6 did NOT silence the stdin-EOF hook noise — "Malformed JSON at stdin EOF"
PostToolUse errors still fire this session. Non-blocking; flag for a real fix.

## Memory pointers
[[backlog-prp-plans]], [[build-env-no-google-maven-fetch]], [[pixel-fold-on-device-qa-quirks]],
[[appendjournal-strips-entry-frontmatter]].
