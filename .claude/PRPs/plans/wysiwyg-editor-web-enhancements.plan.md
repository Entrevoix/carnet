# WYSIWYG editor-web enhancements — paste-markdown (done) + picture insert (next)

Status as of 2026-06-10. Branch `feat/wysiwyg-native-editor`. Both items touch the
`editor-web/*` bundle, so they share the build+verify cycle:
`npm run editor:build` (vite → bakes the COMMITTED `editor-web/generated/editorHtml.js`)
→ `npm run android:release` → verify on-device (release build = no WebView devtools).

---

## ✅ A. Paste raw markdown → formatted (LANDED in this branch)
The official `@tiptap/markdown@3.26` does NOT have the community `tiptap-markdown`'s
`transformPastedText` flag, so paste is handled with a small custom ProseMirror plugin
(`MarkdownPaste` in `editor-web/MarkdownEditor.tsx`): on a plain-text paste (no HTML
clipboard payload) it calls `editor.commands.insertContent(text, { contentType: 'markdown' })`;
HTML/rich pastes fall through to the default handler. Typing markdown shortcuts already
worked via TipTap input rules; this covers pasting a whole markdown block.

Caveat: not adb-verifiable (this device rejects `cmd clipboard set-text`), so the paste
gesture itself needs a manual smoke test on-device.

---

## ⏭ B. Insert a picture from the editor (NEXT — not started)

### What already exists (the easy 60%)
- **Render** works: TenTapStartKit registers the Image extension; `![alt](../Photos/x.jpg)`
  round-trips cleanly (proven in `src/lib/markdownRoundTrip.test.ts`).
- **Storage helpers**: `src/lib/attachments.ts` + the `Photos/` folder convention; carnet
  already writes `![alt](../Photos/<file>.jpg)` links (see PhotoCaptureScreen).
- **Pickers present**: `expo-camera` (capture) and `expo-document-picker`. NOTE: no
  `expo-image-picker`/`expo-media-library` — gallery pick would use document-picker or
  require adding a picker (which then hits [[build-env-no-google-maven-fetch]] if it pulls
  uncached gradle deps — check the cache first).

### The hard 40% — two real problems
1. **No insert UI.** The toolbar has no image button. Add a custom toolbar item (TenTap
   `Toolbar items` prop) OR a button in the RecentDetail rich-edit action bar that:
   pick/capture → copy into the note's `Photos/` via `attachments.ts` → insert the
   `![](../Photos/<file>)` markdown at the cursor (`insertContent({contentType:'markdown'})`).
2. **Displaying the local file INSIDE the WebView is the crux.** The editor WebView loads
   at `webviewBaseURL: 'https://localhost/'`, so a relative `../Photos/x.jpg` (or a bare
   `file://`) will NOT resolve to the on-disk attachment. Options to evaluate:
   - rewrite the image `src` to an absolute `file:///data/.../Photos/x.jpg` just for the
     editor view (and back to the relative form on save) — needs `allowFileAccess*` +
     `allowingReadAccessToURL` on the WebView, and GrapheneOS/Vanadium may still block it;
   - inject the image as a `data:` URI (base64) into the editor and swap back to the
     relative path on serialize — heavier per image but origin-safe;
   - a small in-WebView fetch shim over the MarkdownBridge that streams bytes by path.
   The read-only detail view sidesteps all this with native attachment cards; the editor
   can't.

### Suggested task order
0. Decide the display strategy (spike the `data:`-URI path first — most origin-robust).
1. attachments.ts helper: `addImageToNote(noteDir, srcUri) → { relPath, displayUri }`.
2. Toolbar/action-bar image button → picker → copy → insert relative link.
3. On editor load, rewrite relative image `src` → `displayUri`; on `getMarkdown`, ensure
   the serialized link is the relative `../Photos/...` form (extend MarkdownBridge if needed).
4. On-device verify: insert from camera + from picker; reopen note; confirm the image shows
   in-editor AND the saved `.md` has the relative link AND the detail view still renders it.

### Risks
- Editor-web bundle is fragile (see the native handoff); rebuild + on-device verify each change.
- WebView file access under GrapheneOS Vanadium is the main unknown — prove display before
  building the picker/copy plumbing.

Related: [[build-env-no-google-maven-fetch]], [[backlog-prp-plans]], [[pixel-fold-on-device-qa-quirks]].
