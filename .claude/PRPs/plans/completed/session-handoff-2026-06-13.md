# Session handoff — 2026-06-13

> ⤴ SUPERSEDED by backlog-audit-2026-06-13.md (same day, later — after #43→#45 merged and the backlog audit). Archived snapshot.

> Self-contained state to bridge a `/clear`. No work is in-flight — `main` is clean and
> everything attempted this session is merged or tracked. This is a "where we are" doc.

## Just landed
- **WYSIWYG picture insert → MERGED** (PR #42, squash **`67a254d`**; branch deleted). `main` is at `67a254d`.
  Insert images in the default rich editor: pick → `writeBinary("Photos", …)` → inline `data:`-URI
  preview with the canonical `../Photos/x` path carried in the markdown **title** slot, restored on
  save so the `.md` never holds a base64 blob (enforced postcondition + 22 tests). Files:
  `src/lib/editorImages.ts` (+test), `src/lib/photoDataUri.ts`, `MarkdownBridge.ts` (`insert-markdown`),
  `WysiwygEditor.tsx`, `RecentDetailScreen.tsx`. Full detail: `wysiwyg-picture-insert-status-handoff.md`.
- **On-device smoke PASSED** (Pixel 9 Pro Fold `4A111FDKD0000C`): data-URI renders under
  GrapheneOS/Vanadium; insert works; save writes canonical links (verified via the read-only
  Attachments card — the vault is the private sandbox, unreadable on a release build); existing image
  preserved; no corruption.
- **Cap-raise tried + REVERTED:** raising `MAX_EDITOR_IMAGE_BASE64` 8→24 MB broke body injection on
  device (a ~10 MB+ data URI in one `setMarkdown` silently fails → blank editor → blank-on-save risk).
  Back at 8 MB. The cap bounds the bridge payload, it's not just DOM cost.

## Open follow-ups
- **Issue #43** — (1) preview large images via **inject-then-swap** (inject canonical links first, then
  swap each image to its data URI via its own bounded per-image bridge message); (2) **harden save**
  so a silently-empty editor can never blank a note (`getMarkdown`/`handleSaveWysiwyg`). Both deferred.
- Other WYSIWYG loose ends still open (see `wysiwyg-native-editor-status-handoff.md`): editor-ready ack
  (MEDIUM-4), CSP `<meta>` (LOW-4).
- **STT device-side**: download the on-device speech model on the Pixel + speak-test QA
  ([[pixel-stt-device-recognizer-health]]).

## Env / device gotchas (verified this session)
- **Build + install:** `cd apps/mobile && ANDROID_SERIAL=4A111FDKD0000C ANDROID_HOME=/home/user/Android/Sdk npm run android:release`
  (auto-installs; ~1.5 min, native cached). RN-only changes do NOT need `npm run editor:build`; an
  `editor-web/*` change DOES (then on-device render-verify). metro-runtime pin holds the release bundle.
- **Pixel 9 Pro Fold `4A111FDKD0000C`** (only device attached now): **drops off USB mid-session** →
  `adb kill-server && adb start-server`. **Other apps steal foreground** (the grepon relay
  `cc.grepon.portage.recv`, Signal/Molly) → `adb shell am force-stop <pkg>` + verify `mCurrentFocus`
  before every tap. PIN-locks itself (adb can't unlock — needs the user). **Wireless adb is paired**
  (`user@tower`, Wireless debugging ON) as a USB fallback. Keep awake: `svc power stayon true`.
  Screenshots via `screencap -p /sdcard/x.png && adb pull` (NOT `exec-out`); uiautomator dump gets
  OOM-killed on the editor WebView — rely on screenshots there. App id `com.ventoux.carnet`.
- **Vault is the private app sandbox** (`/data/user/0/com.ventoux.carnet/files/carnet/…`) — unreadable
  on a release build (`run-as` denied). Verify note contents via the in-app read-only render, not raw bytes.
- Disposable QA note **"Jack's Baseball Team"** now carries an extra test image (added during the
  picture-insert smoke; syncs via Syncthing). Safe to delete the note or strip that image.
- **claude-mem 13.5.6 still emits "Malformed JSON at stdin EOF"** PostToolUse hook noise all session —
  NOT fixed by the upgrade; non-blocking, wants a real fix.

## Memory pointers
[[backlog-prp-plans]] (picture insert = #42 merged; cap-raise reverted; #43 follow-ups),
[[build-env-no-google-maven-fetch]], [[pixel-fold-on-device-qa-quirks]],
[[appendjournal-strips-entry-frontmatter]], [[pixel-stt-device-recognizer-health]].
