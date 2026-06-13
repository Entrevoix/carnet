# Handoff: WYSIWYG Phase 2 — Native TenTap Editor (Tasks 6, 7, 9, 11)

> ✅ Handoff for WYSIWYG Phase 2 native build-out — SHIPPED (#33–#35). Archived snapshot.

> Self-contained brief so a fresh session can execute the native WYSIWYG editor cold.
> Source plan: `.claude/PRPs/plans/rich-text-wysiwyg-editor.plan.md` (Tasks 6–11).
> Written 2026-06-09 after the foundation + fidelity gate landed.

---

## TL;DR

The risky parts are **already de-risked**. Fidelity is proven; the build recipe is known. What remains is mechanical-but-heavyweight: install a native module, rebuild, drop in a custom editor web bundle + a markdown bridge, wire the edit-mode switch, and QA on-device. **The ONE unproven thing is whether `@10play/tentap-editor@1.0.1` actually compiles on this stack (Expo SDK 54 / RN 0.81 / New Arch) — prove that FIRST with a throwaway build before building the editor bundle.**

---

## UPDATE 2026-06-09 — gate GREEN + editor built (Tasks 6–7 done); 3 handoff bugs corrected

Branch: **`feat/wysiwyg-native-editor`** (off `main`; the old `feat/wysiwyg-tentap-editor` is stale/superseded — do not reuse). Two commits:
- `ba52f87` — Task 6 GATE: `@10play/tentap-editor@1.0.1` + `react-native-webview@13.15.0` COMPILE on Expo SDK54/RN0.81/NewArch (`prebuild --clean` + `assembleRelease` BUILD SUCCESSFUL, 106 MB APK). **On-device launch NOT yet verified — Pixel was off USB.**
- `bd662e9` — Task 7: editor-web bundle + `MarkdownBridge` + `WysiwygEditor`. `npm run editor:build` builds (93 modules, 924 KB); `tsc` clean; 323/323 vitest green.

**THREE bugs in the recipe below were found by reading the installed node_modules. The steps below are NOT fully correct as written — trust the shipped code (`src/bridges/MarkdownBridge.ts`, `editor-web/MarkdownEditor.tsx`, `editor-web/vite.config.mts`) over this doc:**
1. **Do NOT add `TaskItem` to MarkdownEditor extensions.** `TenTapStartKit`'s `TaskListBridge` already registers `TaskItem.configure({nested:true})` as a dep → re-adding is a tiptap v3 duplicate-extension **runtime crash**. (Step 2's `MarkdownEditor.tsx` snippet is wrong here.)
2. **`TenTapStartKit` has NO code-block node** (`CodeBridge` is the inline `code` mark only; `code.ts` even has `//tiptapExtensionDeps:[CodeBlock]` commented out). Fenced code blocks — a must-have in the fidelity gate — would silently corrupt. FIX (shipped): add `CodeBlock` from `@tiptap/extension-code-block@^3.26.0`. Net MarkdownEditor extensions = `[CodeBlock, Markdown.configure({markedOptions:{gfm:true}})]` only.
3. **`setContent` is tiptap v3:** `editor.commands.setContent(md, { contentType: 'markdown' })` (2 args), NOT the v2 `setContent(md, false, {...})` in Step 3.

Other deltas from the recipe: buildEditor.js emits `editorHtml.js` (not `.ts`); node_modules is HOISTED to repo root (post-build path `../../node_modules/...`). Output dir is **`editor-web/generated/`** (NOT `build/` — that's gitignored); `editorHtml.js` is committed. The bundler is **vite 5 (rollup)** via `--legacy-peer-deps` + esbuild automatic JSX (vite 8/rolldown broke the `/web` alias; `@vitejs/plugin-react` dropped). Known dep debt: duplicate vite 5/7 + triple react-dom — do a clean `rm -rf node_modules && npm install` before the next build.

**REMAINING (both need the Pixel reconnected — do them together so the wiring is QA'd immediately):**
- **Task 9 — RecentDetail edit-mode switch** (Step 5 below). NOT started. Deterministic but edits a hot-path screen; wire it WITH the device so it's testable on the spot. Gated behind `richEditorEnabled` (off by default → zero risk to current behavior until flipped). Import: `import { WysiwygEditor } from '../components/WysiwygEditor'`; on save `const body = await editorRef.current.getMarkdown(); await updateNote(filepath, header + body)`.
- **Task 11 — on-device QA** (Step 6). The editor's markdown FIDELITY is already proven headlessly (the 13-test gate); on-device QA is to confirm the WebView mounts, the bridge round-trips (setMarkdown/getMarkdown), and the toolbar works — plus frontmatter stays byte-identical.

---

## Current state (what's done)

| Item | Status | Where |
|---|---|---|
| `splitFrontmatter()` — byte-exact `header+body===md` | ✅ MERGED | `main` (PR #33, `b4206f5`), `apps/mobile/src/lib/writer.ts` |
| Fidelity gate — tiptap-markdown round-trips carnet notes | ✅ MERGED | `main` (#33), `apps/mobile/src/lib/markdownRoundTrip.test.ts` |
| `@tiptap/* ^3.26.0` + `jsdom` devDeps | ✅ MERGED | `main` (#33), `apps/mobile/package.json` |
| `richEditorEnabled` settings flag (default false) | ✅ pushed | branch `feat/wysiwyg-tentap-editor` `7b1782a` |
| "Rich editor (experimental)" Settings toggle | ✅ pushed | branch `feat/wysiwyg-tentap-editor` `8698e88` |
| Native module install + prebuild + rebuild (Task 6) | ⬜ TODO — **gate** | — |
| `editor-web/` bundle + `MarkdownBridge` + `WysiwygEditor` (Task 7) | ⬜ TODO | — |
| RecentDetail edit-mode switch (Task 9) | ⬜ TODO | `apps/mobile/src/screens/RecentDetailScreen.tsx` |
| On-device WYSIWYG QA (Task 11) | ⬜ TODO | Pixel 9 Pro Fold (serial `4A111FDKD0000C`) |

**Branch to continue on:** `feat/wysiwyg-tentap-editor` (pushed to origin, 2 commits ahead of `main`). Base `main`. No open PR yet — open one when the native editor lands, or earlier for the settings flag if you want it in main sooner.

## Decisions already made (do NOT re-litigate)

1. **Library:** `@10play/tentap-editor` (TenTap = TipTap-in-WebView). Markdown via **`@tiptap/markdown`** (official, tiptap v3) — NOT the deprecated `tiptap-markdown` (aguingand).
2. **TenTap 1.0.1 is the SDK-54/RN-0.81 fix.** GitHub issue #330 ("Build errors with expo 54 and react-native 0.81") is **CLOSED** (2025-11-27); maintainer: "fixed in the latest release" → that's 1.0.1 (latest published; no newer version exists as of 2026-06). Earlier research flagged #330 as open from its "same problem" comments — it's resolved.
3. **Fidelity verdict:** all must-have constructs round-trip clean (task lists `[ ]`/`[x]`, relative image paths `![](../Photos/x)`, headings/bold/italic/code/links/nested lists). One **accepted known limitation**: prose underscores get backslash-escaped on serialize (`foo_bar` → `foo\_bar`), render-equivalent, code spans unaffected. Surface in-app; do not block on it.
4. **Markdown stays source of truth on disk.** The editor only ever exchanges markdown strings; frontmatter is split off with `splitFrontmatter()` and reattached verbatim. Editor never sees `---` fences.
5. **`android/` is CNG** (gitignored) → `expo prebuild` is safe (no committed native dirs to overwrite). New Arch is on (SDK 54 default). **Never `expo install --fix`** (memory: `expo-doctor-worklets-downgrade-trap`).

---

## STEP 1 — Build-compat gate (do this FIRST, ~10 min)

Prove TenTap compiles on this stack before building the editor bundle. If it fails, the feature is blocked on TenTap — stop and see "If TenTap won't build" below.

```bash
cd apps/mobile
npx expo install react-native-webview      # resolves the SDK-54-compatible ~13.x
npm install @10play/tentap-editor@1.0.1
npx expo prebuild --platform android       # regenerates the CNG android/ with the native module autolinked
npm run android:release                    # gradle assembleRelease + install to device
```

**Verify:** install succeeds, prebuild succeeds, `BUILD SUCCESSFUL`, app launches clean on the Pixel (`adb -s 4A111FDKD0000C logcat` shows `ReactNativeJS: Running "main"`, no FATAL). Optionally render a *default* TenTap editor (no custom bundle yet — `useEditorBridge` with no `customSource`) on a scratch screen to confirm the WebView mounts.

If green → proceed to Step 2. This is the make-or-break for the whole feature.

---

## STEP 2 — Custom editor-web bundle (Task 7a)

TenTap ships no built-in markdown bridge; you build a custom editor web bundle that includes `@tiptap/markdown`, compiled to a single HTML string the RN side imports.

**Extra deps (in `apps/mobile/`, NOT inside `editor-web/`):**
```bash
npm install -D vite @vitejs/plugin-react vite-plugin-singlefile @types/react-dom
npm install react-dom @tiptap/extension-task-item   # @tiptap/markdown already on main from #33
# @tiptap/extension-task-list + @tiptap/extension-image are deps of tentap itself
```

**Layout:** `apps/mobile/editor-web/{vite.config.ts,tsconfig.json,index.html,index.tsx,MarkdownEditor.tsx}` + shared `apps/mobile/src/bridges/MarkdownBridge.ts`.

**Root `apps/mobile/tsconfig.json`:** add `"exclude": ["./editor-web"]` so RN tsc doesn't read DOM-lib editor types.

**`editor-web/tsconfig.json`** — `lib: [dom, dom.iterable, esnext]`, `jsx: react-jsx`, `moduleResolution: bundler`, `esModuleInterop: true`, `skipLibCheck: true`, and a path alias for `@10play/tentap-editor` → `../node_modules/@10play/tentap-editor/lib-web/typescript/webEditorUtils/index.d.ts`.

**`editor-web/index.html`** — `#root` div + `<script type="module" src="/index.tsx">`; copy the CSS block from `10TapAdvancedExample/editor-web/index.html` (positions `.ProseMirror`, removes focus outline, supports `.dynamic-height`).

**`editor-web/index.tsx`** (verbatim from `10play/10TapAdvancedExample`) — polls `window.contentInjected` then `createRoot(...).render(<MarkdownEditor/>)`. Needed because RN-WebView injects content after load on Android.

**`editor-web/MarkdownEditor.tsx`:**
```tsx
import { EditorContent } from "@tiptap/react";
import { useTenTap, TenTapStartKit } from "@10play/tentap-editor";
import { Markdown } from "@tiptap/markdown";
import TaskItem from "@tiptap/extension-task-item";
import { MarkdownBridge } from "../src/bridges/MarkdownBridge";

export const MarkdownEditor = () => {
  const editor = useTenTap({
    bridges: [...TenTapStartKit, MarkdownBridge],
    tiptapOptions: {
      extensions: [
        // ⚠️ TenTapStartKit ALREADY registers Bold/Italic/Heading/BulletList/
        // OrderedList/Link/Code/TaskList/Image. Re-registering ANY of them is a
        // tiptap v3 duplicate-extension RUNTIME ERROR. Audit node_modules/
        // @10play/tentap-editor/src/bridges/ before adding. Safe to add:
        TaskItem.configure({ nested: true }),   // override to enable nested task lists
        Markdown.configure({ markedOptions: { gfm: true } }), // gfm REQUIRED for - [ ] parsing
      ],
    },
  });
  return <EditorContent editor={editor} className={window.dynamicHeight ? "dynamic-height" : undefined} />;
};
```

**`editor-web/vite.config.ts`** — `root: "editor-web"`, `build.outDir: "build"`, `build.emptyOutDir: false`, plugins `[react(), viteSingleFile()]`, and **critical alias** redirecting `@10play/tentap-editor` + `@tiptap/pm/view` + `@tiptap/pm/state` → `@10play/tentap-editor/web` (else Vite pulls Node-incompatible ProseMirror code).

**Build scripts (apps/mobile/package.json):**
```json
"editor:build": "vite --config ./editor-web/vite.config.ts build && npm run editor:post-build",
"editor:post-build": "node ./node_modules/@10play/tentap-editor/scripts/buildEditor.js ./editor-web/build/index.html"
```
`npm run editor:build` → emits `apps/mobile/editor-web/build/editorHtml.ts` exporting `editorHtml: string`. The RN side imports that module; the HTML is baked into the JS bundle (not fetched at runtime).

---

## STEP 3 — MarkdownBridge (Task 7b)

`apps/mobile/src/bridges/MarkdownBridge.ts` — imported by BOTH the web `MarkdownEditor.tsx` and the RN `WysiwygEditor.tsx`. Authors a `BridgeExtension` exposing `setMarkdown(md)` / `requestMarkdown()`.

Key mechanics (from TenTap `src/bridges/base.ts`):
- **Web side** `onBridgeMessage(editor, msg, sendMessageBack)`:
  - `SetMarkdown` → `editor.commands.setContent(payload, false, { contentType: "markdown" })` — **`contentType:'markdown'` is MANDATORY**; omitting it treats input as HTML and silently corrupts.
  - `RequestMarkdown` → `(editor as any).getMarkdown()` (added at runtime by `@tiptap/markdown`; cast because the bridge file must NOT import `@tiptap/markdown`) → `sendMessageBack({ type: MarkdownResponse, payload: md })`.
- **RN side** `extendEditorInstance(sendBridgeMessage)` → `{ setMarkdown, requestMarkdown }` that post messages in.
- **RN side** `onEditorMessage(msg)` → on `MarkdownResponse`, resolve the pending promise (module-level `_resolveMarkdown` slot; one request at a time is fine for save-on-demand).
- `declare module "@10play/tentap-editor"` to augment `EditorBridge`/`BridgeState` with the new methods.

(Full verbatim skeleton is in the research output captured in the session transcript / ask the research agent `a18a409352defd3e2`; or mirror `10TapAdvancedExample/CounterBridge.ts`.)

---

## STEP 4 — `WysiwygEditor.tsx` (Task 7c)

`apps/mobile/src/components/WysiwygEditor.tsx`, `forwardRef<WysiwygEditorRef, { value: string; onChangeMarkdown?: (md)=>void }>`:
- `useEditorBridge({ customSource: editorHtml, bridgeExtensions: [...TenTapStartKit, MarkdownBridge], autofocus: false, avoidIosKeyboard: true, initialContent: "<p></p>" })` — **`initialContent` is HTML-only; never pass raw markdown there (silent corruption).**
- After mount, inject the markdown body via `editor.setMarkdown(value)`. TenTap 1.0.1 has **no "editor ready" event** — use the documented `setTimeout(~150ms)` after mount (10TapAdvancedExample pattern), guarded by an `initializedRef`.
- Expose `getMarkdown(): Promise<string>` via `useImperativeHandle` — sets a resolver, calls `editor.requestMarkdown()`, resolves when `onEditorMessage` fires.
- Render `<RichText editor={editor} />` + a keyboard-avoiding `<Toolbar editor={editor} />`.

---

## STEP 5 — RecentDetail edit-mode switch (Task 9b)

In `apps/mobile/src/screens/RecentDetailScreen.tsx` edit mode:
- Read `richEditorEnabled` from settings (already wired through `getSettings()`).
- On `enterEdit`: `const { header, body } = splitFrontmatter(noteContent)`; stash `header`; feed `body` to the editor.
- When `richEditorEnabled` → render `<WysiwygEditor ref={editorRef} value={body} />` instead of the markdown `TextInput` + `MarkdownToolbar`. When off → exactly the current Phase-1 path (no WebView mounted).
- On save: `const editedBody = await editorRef.current.getMarkdown(); await updateNote(entry.filepath, header + editedBody)`.

## STEP 6 — On-device QA (Task 11)

Pixel 9 Pro Fold. Build: `npm run android:release` (auto-installs). Test against real notes with the toggle ON:
- Edit a note with headings/bold/lists/**task list**/**image embed**/code → save → confirm the `<Markdown>` re-render matches and the raw `.md` stays clean (diff before/after).
- **Frontmatter byte-identical** after a body edit (the whole point of `splitFrontmatter`).
- Toggle OFF → behavior is exactly Phase 1 (no WebView).
- Device quirks: [[pixel-fold-on-device-qa-quirks]] (dual-display `input -d 0`, drops off USB).

---

## Validation

```bash
cd apps/mobile
npx tsc --noEmit                                   # editor-web excluded from RN tsc
npx vitest run                                     # 323 baseline; round-trip gate must stay green
npm run editor:build                               # emits editor-web/build/editorHtml.ts
npm run android:release                            # BUILD SUCCESSFUL + installs
```
Acceptance: WYSIWYG round-trips to clean markdown; frontmatter never altered; gated behind the off-by-default toggle; tsc clean; full vitest green; release build succeeds; on-device QA passes.

## If TenTap won't build (Step 1 fails)

The feature is blocked on the library. Options, in order:
1. Check `10play/10tap-editor` for a release > 1.0.1 or an open PR; pin/patch.
2. `patch-package` the specific RN-0.81 build error if it's a known one in the issue thread.
3. Fallback editors (both were rejected in the source plan, revisit only if blocked): `react-native-pell-rich-editor` (HTML-centric, no markdown advantage), Lexical-RN (was not production-ready). 
4. Defer until TenTap ships an SDK-55-era release.
Report the exact build error and stop — do not hand-roll a WebView editor.

## Gotchas (collected)

- Duplicate tiptap extensions = runtime error (TenTapStartKit already has most). `TaskItem.configure({nested:true})` overrides, not duplicates.
- `setContent(..., { contentType: "markdown" })` mandatory; `initialContent` is HTML-only.
- `getMarkdown()`/`contentType:'markdown'` come from `@tiptap/markdown` at runtime; the bridge file must NOT import it (keep that import on the web side only, which is tsc-excluded).
- No "editor ready" event → `setTimeout(150)` heuristic.
- `expo prebuild` regenerates CNG `android/` (safe, gitignored). Never `expo install --fix`.
- The custom bundle's tiptap versions must match TenTap's `@tiptap/* ^3.11.0` floor; we pin `@tiptap/markdown ^3.12.0+` (escape/mark-bleed fixes).

## References

- Source plan: `.claude/PRPs/plans/rich-text-wysiwyg-editor.plan.md`
- TenTap advanced setup: https://10play.github.io/10tap-editor/docs/setup/advancedSetup
- Reference repo (verbatim source for the recipe): https://github.com/10play/10TapAdvancedExample
- Issue #330 (CLOSED, the SDK54/RN081 fix): https://github.com/10play/10tap-editor/issues/330
- Memory: [[backlog-prp-plans]], [[native-plugin-kotlin-verification]], [[expo-doctor-worklets-downgrade-trap]], [[pixel-fold-on-device-qa-quirks]]
