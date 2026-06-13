# Handoff: WYSIWYG native editor — SHIPPED to main (loose ends deferred)

> Self-contained status as of 2026-06-11. The TenTap WYSIWYG note editor is built,
> reviewed, **merged to `main`, and is now the DEFAULT note editor** (the experimental
> flag was removed). A handful of low-risk loose ends were deliberately deferred — to be
> picked up AFTER the next implementation. This doc is the context bridge across a `/clear`.

## TL;DR — DONE
- Rich (WYSIWYG/TenTap) editor is **merged to `main`** as **PR #35, squash `bec5ea6`** (branch
  `feat/wysiwyg-native-editor` deleted). It is now the **default** note editor — no longer gated.
- Edits exchange **markdown only** (carnet's on-disk source of truth) via `MarkdownBridge`;
  frontmatter is split off on enter and reattached byte-exact on save (editor never sees `---`).
- CI green (shared/mobile/desktop/gate); **334/334 vitest**; tsc clean; verified on-device
  (Pixel 9 Pro Fold) — renders, edit→save round-trips, top toolbar, paste-markdown, bold/etc.

## What shipped (the whole feature)
1. Deps: TenTap `@10play/tentap-editor` 1.0.1 + `react-native-webview`.
2. `editor-web/` Vite bundle → committed `editor-web/generated/editorHtml.js`; `MarkdownEditor.tsx`
   (TenTapStartKit + `@tiptap/extension-code-block` + `@tiptap/markdown` gfm + `MarkdownPaste`).
3. `src/bridges/MarkdownBridge.ts` (markdown↔HTML bridge) + `src/bridges/markdownResponse.ts`
   (RN-side reply resolver with a 5s timeout + cleanup, unit-tested).
4. `src/components/WysiwygEditor.tsx` (RN component: body injection, top toolbar, dark-icon theme).
5. `src/screens/RecentDetailScreen.tsx` full-screen rich-edit early-return (Cancel/Save + discard
   dialog); the markdown `TextInput` path remains as the dormant `richEditorEnabled === false` branch.
6. **3 on-device render fixes** (orig commit 006dc82): `webviewBaseURL: 'https://localhost/'`
   (Vanadium blocks `<script type=module>` under a null origin); absolute react/react-dom alias in
   `vite.config.mts` (kills the React 18/19 dedupe crash); `onLoad`-anchored body injection.
7. **Top toolbar** (compact 48dp row, dark icons) — NOT above-keyboard (see "why" below).
8. **Paste raw markdown** (`MarkdownPaste` ProseMirror plugin; `markdownFromClipboard` helper).
9. Review fixes (cb79880) + **flag removal** (4808b19): `richEditorEnabled` defaults true; the
   "Rich editor (experimental)" Settings toggle is gone.

## ⛔ DON'T re-walk these (already solved / known)
- **Why the toolbar is TOP-docked, not above the keyboard:** Expo SDK54 / RN0.81 Android
  **edge-to-edge** kills `adjustResize` + `KeyboardAvoidingView` (zero lift), and RN's `Keyboard`
  height UNDER-reports the IME (omits Gboard's suggestion strip — true `WindowInsets.ime`=1065 vs
  RN's 906). The proper fix, `react-native-keyboard-controller`, **can't build in this env** — the
  sandbox blocks Google-Maven fetches for its uncached transitive deps. See [[build-env-no-google-maven-fetch]].
- **Hermes UTF-16 trap:** the gradle release bundle stores `editorHtml` as UTF-16, so ASCII
  `grep` on the APK gives FALSE NEGATIVES. Verify on-device, not by grepping the bundle.
- **No new native modules** without checking the local gradle cache first (same egress wall).

---

## ⏭ DEFERRED LOOSE ENDS — pick up AFTER the next implementation
Full write-up: **`.claude/PRPs/plans/wysiwyg-editor-web-enhancements.plan.md`**. All four need the
Pixel in hand (device keeps locking + dropping USB during long sessions — see quirks below).

1. **On-device Settings smoke (5 min, low-risk).** Confirm post-flag-removal: Settings has NO "Rich
   editor (experimental)" row; opening a note → Edit goes straight to the rich editor with the top
   toolbar. (Structurally covered by tsc + CI; just an eyeball confirm. The merged build is already
   installed on the device.)
2. **Picture insert (the big one).** Render already works (`![](../Photos/x.jpg)` round-trips;
   `lib/attachments.ts` + `Photos/` convention + camera/document-picker exist). Missing: a toolbar
   image button → pick/capture → copy into `Photos/` → insert the link. **Crux:** displaying the
   local file INSIDE the WebView (loads at `https://localhost/`, so relative/`file://` won't resolve)
   — recommend a **data-URI swap** on load, relative link on save. Spike display first.
3. **MEDIUM-4: editor-ready ack** (replace the blind 100/400/900ms + 2500ms injection staircase with
   a web-side `editor-ready` post; stop on first ack). Changes the verified-working cold-start timing
   → needs on-device timing verification. Touches `editor-web/*` → rebuild + smoke.
4. **LOW-4: CSP `<meta>`** in `editor-web/index.html`. Review said "not required now"; a wrong CSP can
   block the bundle's own module script (the null-origin class we already fought). Only with care.

## ▶ The actual NEXT implementation
User-directed (they'll say after the `/clear`). Documented candidate in the backlog:
**`.claude/PRPs/plans/wysiwyg-location-tags.plan.md`** (Location picker + Tag system, RN/Expo-corrected;
starts with Task 0 — a shared `src/lib/frontmatter.ts` upsert + tags-array helpers). The WYSIWYG
loose ends above are explicitly NOT this; they come after.

---

## Build + on-device QA reference
- **Build+install:** `cd apps/mobile && npm run android:release` (auto-installs if a device is
  connected; otherwise prints the `adb install` command). Editor bundle clean: `rm -rf /tmp/metro-*
  node_modules/.cache` only if `editor-web/*` changed.
- **Editor bundle** (only if `editor-web/*` sources change): `npm run editor:build` → vite builds
  `editor-web/index.tsx` → bakes the COMMITTED `editor-web/generated/editorHtml.js`. Then a full app
  rebuild. ALWAYS on-device smoke-test render after — a bundle that builds can still fail to render.
- **Tests/typecheck:** `npm test` (vitest, currently 334) and `npx tsc --noEmit`.
- **Device:** Pixel 9 Pro Fold, serial `4A111FDKD0000C`, GrapheneOS / Vanadium WebView. FOLDABLE:
  drops off USB, re-attaches "unauthorized" (`adb kill-server && adb start-server`), LOCKS itself
  (needs the user's PIN — `adb` can't unlock), and OTHER APPS steal foreground (Molly/Signal, the
  grepon relay, AntennaPod). Mitigations that worked: `adb shell cmd notification set_dnd none` (total
  silence) + `adb shell am force-stop <pkg>` for the offenders; verify `mCurrentFocus` is carnet before
  every tap; use `uiautomator dump` for live coords (layout shifts between folds); screencap via
  `adb shell screencap -p /sdcard/x.png && adb pull` (NOT `exec-out` — dual-display warning strip
  corrupts it). `adb cmd clipboard set-text` is REJECTED on this device (can't auto-test paste gestures).
- Release build is **non-debuggable** (no `run-as`, no chrome://inspect). To inspect the WebView, add a
  temporary error-catcher to `editor-web/index.{html,tsx}` + `npm run editor:build`.

## Loose data note
The disposable test note **"Jack's Baseball Team"** carries stray edits ("Thr", a flipped "personal")
from on-device QA focus-steal churn. Safe to delete; not a round-trip bug (the 334-test gate proves
clean serialization).

## Memory pointers
[[backlog-prp-plans]] (WYSIWYG now MERGED), [[build-env-no-google-maven-fetch]],
[[pixel-fold-on-device-qa-quirks]], [[expo-doctor-worklets-downgrade-trap]],
[[native-plugin-kotlin-verification]].
