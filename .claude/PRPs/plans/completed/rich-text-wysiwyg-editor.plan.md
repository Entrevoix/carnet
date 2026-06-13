# Plan: Rich-Text Editing — Markdown Toolbar now, WYSIWYG later

> ✅ SHIPPED — Phase 1 markdown toolbar (#31 75b19c3); Phase 2 TenTap WYSIWYG editor (#33 b4206f5, #34 346697f, #35 bec5ea6, now the default editor). Archived.

## Summary
Upgrade carnet's note editing from a plain markdown `TextInput` to a richer experience, in two phases that protect the markdown-on-disk model. **Phase 1**: a selection-aware **markdown formatting toolbar** over the *existing* edit-mode `TextInput` (bold/italic/headings/lists/checkbox/link/code/insert-image) — zero round-trip risk, no new native surface. **Phase 2 (the deferred "WYSIWYG" ask)**: a true visual editor (TenTap = TipTap-in-a-WebView) with `@tiptap/markdown` doing all md↔editor conversion *inside* the WebView, YAML frontmatter split off and reattached verbatim, gated behind parse→serialize identity tests on real notes and an experimental settings toggle.

## User Story
As a carnet user, I want to format my notes without hand-typing markdown — bold, headings, lists, checkboxes, links, inline images — and eventually edit them visually (WYSIWYG), so that writing feels rich while my notes stay clean markdown files in my own folder.

## Problem → Solution
**Current:** Note editing is a raw-markdown `TextInput` (`RecentDetailScreen` edit mode → `updateNote`). Good, but you type markdown by hand and there's no formatting assist or visual editing.
**Desired:** A formatting toolbar that inserts/wraps markdown around the selection (Phase 1), and — later — an optional WYSIWYG editor that round-trips to byte-clean markdown (Phase 2), never touching the YAML frontmatter.

## Metadata
- **Complexity**: Large (Phase 1 Medium; Phase 2 Large + new native module + fidelity risk)
- **Source PRD**: N/A (free-form `/prp-plan`: "rich text later wsiwyg editor later")
- **PRD Phase**: N/A
- **Estimated Files**: Phase 1 ≈ 4-5; Phase 2 ≈ 5-7
- **Framing**: User explicitly wants both as **later** work; this captures the plan. Recommended order: toolbar first (ships safely), WYSIWYG second (after fidelity is proven on the real corpus).

---

## UX Design

### Before
```
RecentDetail → [Edit] →
┌──────────────────────────────┐
│ Editing  (Markdown + frontmatter)
│ ┌──────────────────────────┐ │
│ │ ## Heading               │ │   ← raw markdown TextInput
│ │ - hand-typed list        │ │
│ └──────────────────────────┘ │
│        [Cancel]  [Save]      │
└──────────────────────────────┘
```

### After — Phase 1 (toolbar)
```
┌──────────────────────────────┐
│ Editing
│ [B][I][H1][H2][•][1.][☑][🔗][</>][📷]   ← toolbar acts on selection
│ ┌──────────────────────────┐ │
│ │ **bold** selection        │ │
│ └──────────────────────────┘ │
│ [👁 Preview]                  │   ← optional live <Markdown> preview
│        [Cancel]  [Save]      │
└──────────────────────────────┘
```

### After — Phase 2 (WYSIWYG, deferred)
```
┌──────────────────────────────┐
│ Editing (Rich · experimental) │
│ [B][I][H▾][•][1.][☑][🔗][📷]   │
│ ┌──────────────────────────┐ │
│ │ Heading rendered bold     │ │   ← TipTap WebView, visual
│ │ • rendered bullet         │ │
│ └──────────────────────────┘ │
│   frontmatter untouched ↑     │
│        [Cancel]  [Save]      │   ← serialize→clean .md on disk
└──────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Edit mode body | raw markdown TextInput | TextInput **+ formatting toolbar** (P1) | Toolbar wraps/prefixes the current selection |
| Insert image while editing | n/a | toolbar 📷 → picker → `writeBinary` → `![](../Photos/x)` at cursor | Composes with the attachments plan |
| Live preview | none | optional **Preview** toggle (P1) | Reuses `<Markdown>` + `markdownStyle` |
| Visual editing | none | **WYSIWYG** behind a settings toggle (P2) | TenTap WebView; off by default |
| Frontmatter | edited inline as text | **split off, never shown to WYSIWYG, reattached verbatim** (P2) | Prevents the #1 corruption mode |
| On-disk format | markdown | **still markdown** | Non-negotiable; identity tests enforce |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/screens/RecentDetailScreen.tsx` | 61-98, 230-234, 268-321, 484-553, 661-703 | Existing edit mode (state, enterEdit, handleSaveEdit, edit render, markdownStyle) — the thing being upgraded |
| P0 | `src/lib/writer.ts` | 472-499, 502-550, 706-714 | `readNote`/`updateNote`, `stripFrontmatter`, `extractFrontmatterField`, `rewriteFrontmatterField` |
| P1 | `src/lib/writer.test.ts` | 475-489 | readNote→updateNote round-trip test to mirror for serialization identity tests |
| P1 | `src/screens/SettingsScreen.tsx` | 189-215, 369-422 | Toggle/field pattern for the "Rich editor (experimental)" setting (P2) |
| P1 | `src/lib/settings.ts` | 37-59, 167-200 | Add `richEditorEnabled` flag (P2), mirroring existing boolean settings |
| P2 | `src/lib/attachments.ts` *(from attachments plan)* | n/a | `pickAttachment` reuse for toolbar "insert image" |
| P2 | `App.tsx` | 28-36, 190-194 | RecentDetail route params (`entry: CaptureEntry`) — no separate edit screen exists |

> Depends on / composes with `.claude/PRPs/plans/rich-content-attachments.plan.md` (the image-insert toolbar action reuses its `writeBinary` + `injectImageEmbed` + picker). If that plan isn't implemented yet, Phase 1's image button can be deferred or carry its own minimal picker.

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| TenTap editor | https://github.com/10play/10tap-editor · https://www.npmjs.com/package/@10play/tentap-editor | v1.0.1 (2025-11-27); TipTap-in-WebView; **peerDep `react-native-webview`**; "new arch on RN ≥0.73.5"; full features need a dev client |
| Tiptap Markdown | https://tiptap.dev/docs/editor/markdown · https://github.com/aguingand/tiptap-markdown | Bidirectional md↔editor **inside the WebView** (`getMarkdown`/`parse`/`serialize`) — avoids `turndown`/DOM-shim on the RN side |
| Round-trip corruption (must-read) | https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/440 · https://github.com/ueberdosis/tiptap/issues/7731 | Documented: frontmatter collapsed, `[x]`/`_word` over-escaped, blank lines/nested lists flattened, `<br>` dropped → identity tests are mandatory |
| react-native-webview on Expo | https://docs.expo.dev/versions/latest/sdk/webview/ | `npx expo install react-native-webview`; native code → **prebuild/dev-client rebuild**; New-Arch compatible |
| Expo richtext guide | https://docs.expo.dev/guides/editing-richtext/ | Confirms WebView-based editors + the markdown-toolbar middle ground |

---

## Patterns to Mirror

### EXISTING_EDIT_MODE (Phase 1 upgrades this in place)
```tsx
// SOURCE: src/screens/RecentDetailScreen.tsx:484-509 (edit render)
<Card>
  <Card.Title title="Editing" subtitle="Markdown + frontmatter" />
  <Card.Content>
    <TextInput mode="outlined" multiline numberOfLines={16}
      value={draft} onChangeText={setDraft} style={styles.editor}
      autoCorrect={false} autoCapitalize="none" />
  </Card.Content>
  <Card.Actions>
    <Button onPress={cancelEdit}>Cancel</Button>
    <Button mode="contained" onPress={handleSaveEdit} disabled={!isDirty}>Save</Button>
  </Card.Actions>
</Card>
```

### EDIT_STATE + SAVE
```ts
// SOURCE: src/screens/RecentDetailScreen.tsx:72-75, 230-234, 268-308
const [editMode, setEditMode] = useState(false);
const [draft, setDraft] = useState("");
const enterEdit = () => { setDraft(body); setEditError(null); setEditMode(true); };
const handleSaveEdit = async () => { /* … */ await updateNote(entry.filepath, draft); /* update recents title */ };
```

### NOTE_PERSIST (works for file:// and SAF content://)
```ts
// SOURCE: src/lib/writer.ts:706-714
export async function readNote(filepath: string): Promise<string> { return readByUri(filepath); }
export async function updateNote(filepath: string, markdown: string): Promise<void> { await writeByUri(filepath, markdown); }
```

### FRONTMATTER_SPLIT (extend for verbatim reattach — P2)
```ts
// SOURCE: src/lib/writer.ts:492-499
export function stripFrontmatter(markdown: string): string {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return markdown;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return markdown;
  return afterFirst.slice(endIdx + 4).replace(/^\n+/, "");
}
// P2 adds splitFrontmatter(md): { header: string; body: string } using the same scan,
// returning the RAW header (incl. the --- fences) so it can be re-prepended byte-exact.
```

### MARKDOWN_PREVIEW_STYLE (reuse for Phase 1 preview)
```ts
// SOURCE: src/screens/RecentDetailScreen.tsx:661-703
function markdownStyle(theme) { return { body, heading1, heading2, code_inline, fence, link, bullet_list, ordered_list /* … */ }; }
```

### ROUND_TRIP_TEST
```ts
// SOURCE: src/lib/writer.test.ts:475-489
it("round-trips content through readNote → updateNote → readNote", async () => {
  const { filepath } = await writeIdea("round-trip", "# Original\n");
  await updateNote(filepath, "# Updated\n");
  expect(await readNote(filepath)).toBe("# Updated\n");
});
```

---

## Files to Change

### Phase 1 — Markdown Formatting Toolbar
| File | Action | Justification |
|---|---|---|
| `src/lib/markdownEdit.ts` | CREATE | Pure selection-transform helpers: `wrapSelection`, `prefixLines`, `insertAtCursor` (each returns `{text, selection}`) |
| `src/components/MarkdownToolbar.tsx` | CREATE | Presentational toolbar (paper `IconButton`s) calling the helpers + an `onInsertImage` hook |
| `src/screens/RecentDetailScreen.tsx` | UPDATE | Track `selection` on the edit `TextInput`; mount `MarkdownToolbar`; optional Preview toggle |
| `src/lib/markdownEdit.test.ts` | CREATE | Unit-test the pure helpers (wrap toggle, multi-line prefix, cursor math) |
| `src/screens/RecentDetailScreen.tsx` (image) | UPDATE | Toolbar 📷 → `pickAttachment` → `writeBinary("Photos",…)` → insert `![](../Photos/finalName)` at cursor |

### Phase 2 — WYSIWYG (deferred)
| File | Action | Justification |
|---|---|---|
| `package.json` | UPDATE | `npx expo install react-native-webview` + `@10play/tentap-editor` + a tiptap-markdown extension |
| `src/components/WysiwygEditor.tsx` | CREATE | TenTap `useEditorBridge` with `@tiptap/markdown` bundled in the WebView; bridge exchanges **markdown strings only** |
| `assets/editor/*` (or inline) | CREATE | The WebView editor bundle/HTML with tiptap + markdown extension + the matching node extensions |
| `src/lib/writer.ts` | UPDATE | Add `splitFrontmatter(md): {header, body}` for verbatim frontmatter preservation |
| `src/lib/settings.ts` | UPDATE | Add `richEditorEnabled: boolean` (default false) |
| `src/screens/SettingsScreen.tsx` | UPDATE | "Rich editor (experimental)" toggle |
| `src/screens/RecentDetailScreen.tsx` | UPDATE | When toggle on, swap the TextInput edit card for `WysiwygEditor` (body only; frontmatter reattached on save) |
| `src/lib/markdownRoundTrip.test.ts` | CREATE | parse→serialize identity tests on a real-note corpus (gate the feature) |

## NOT Building
- **Changing the on-disk format** — notes stay markdown; no HTML/JSON storage.
- **Letting the WYSIWYG editor touch YAML frontmatter** — it's split off and reattached verbatim.
- **`turndown` / DOM-shim on the RN side** — all md↔editor conversion happens inside the WebView.
- **Lexical-RN** — not production-ready; excluded.
- **Collaborative/real-time editing, comments, version history** — out of scope.
- **Capture-time rich editing** — editing is on existing notes (RecentDetail); capture stays quick-entry.
- **Phase 2 enabled by default** — ships off, behind an experimental toggle, until fidelity is proven.

---

## Step-by-Step Tasks (Phase 1 — Toolbar)

### Task 1: `src/lib/markdownEdit.ts` — pure selection transforms
- **ACTION**: Implement cursor/selection-aware markdown insertion helpers.
- **IMPLEMENT**:
  - `interface Sel { start: number; end: number }`
  - `wrapSelection(text, sel, marker): { text, selection }` — wrap selected range with `marker` (e.g. `**`, `*`, `` ` ``); if already wrapped, unwrap (toggle); if empty selection, insert `marker+marker` and place cursor between.
  - `prefixLines(text, sel, prefix): { text, selection }` — prepend `prefix` (`# `, `## `, `- `, `1. `, `- [ ] `) to each line overlapping the selection; for ordered lists increment numbers.
  - `insertAtCursor(text, sel, snippet, cursorOffset?): { text, selection }` — insert `snippet` (e.g. `[text](url)` link, image embed) and position cursor.
- **MIRROR**: codebase pure-helper style in `writer.ts` (e.g. `injectImageEmbed`, `slugify`) — exported pure functions, explicit returns, no mutation.
- **IMPORTS**: none.
- **GOTCHA**: keep everything immutable; return BOTH new text and new selection so the caller can re-set the TextInput selection (cursor jumps are the main UX bug). Handle `\r\n` and selection at string end.
- **VALIDATE**: `markdownEdit.test.ts` covers wrap/unwrap toggle, multi-line prefix, empty-selection insert, end-of-string.

### Task 2: `src/components/MarkdownToolbar.tsx`
- **ACTION**: A horizontal toolbar of `IconButton`s that emits formatting intents.
- **IMPLEMENT**: Props `{ onFormat: (kind: FormatKind) => void; onInsertImage: () => void; disabled?: boolean }`. Buttons: bold, italic, h1, h2, bullet, ordered, checkbox, link, inline-code/fence, image. Use react-native-paper `IconButton` + a horizontal `ScrollView` (compact). No state of its own.
- **MIRROR**: react-native-paper usage + `markdownStyle` theme colors in RecentDetailScreen.
- **IMPORTS**: `IconButton` from `react-native-paper`.
- **GOTCHA**: keep it presentational; the screen owns `draft`/`selection` and applies the transforms (so undo/dirty tracking stays in one place).
- **VALIDATE**: renders; buttons fire `onFormat`/`onInsertImage` (light component test or manual).

### Task 3: Wire toolbar + selection into RecentDetail edit mode
- **ACTION**: Track the TextInput selection and apply toolbar transforms to `draft`.
- **IMPLEMENT**:
  - Add `const [selection, setSelection] = useState<Sel>({start:0,end:0})`; on the edit `TextInput` add `selection={selection}` and `onSelectionChange={e => setSelection(e.nativeEvent.selection)}`.
  - `applyFormat(kind)` maps kind → the right helper (`wrapSelection`/`prefixLines`/`insertAtCursor`), then `setDraft(next.text)` and `setSelection(next.selection)`.
  - Mount `<MarkdownToolbar onFormat={applyFormat} onInsertImage={insertImage} />` above the TextInput (edit render block 484-509).
- **MIRROR**: existing edit render + `setDraft`/`isDirty` flow (268-308).
- **IMPORTS**: `MarkdownToolbar`, helpers from `../lib/markdownEdit`.
- **GOTCHA**: controlling `selection` on a multiline RN TextInput can fight the IME — set it only right after a toolbar action (not on every keystroke) to avoid cursor jitter; let `onSelectionChange` otherwise own it.
- **VALIDATE**: on-device — select text, tap Bold → wraps `**…**`, cursor sane; Save → `updateNote` persists; reopen renders bold.

### Task 4: Toolbar "insert image"
- **ACTION**: Insert an image into the note body during edit.
- **IMPLEMENT**: `insertImage()` → `pickAttachment()` (from attachments plan) → `writeBinary("Photos", `${slug}.${ext}`, base64, mime)` → `insertAtCursor(draft, selection, `![](../Photos/${finalName})`)`.
- **MIRROR**: attachments plan SHARE_IMAGE_FLOW; `injectImageEmbed`.
- **IMPORTS**: `pickAttachment` (`../lib/attachments`), `writeBinary` (`../lib/writer`).
- **GOTCHA**: this writes a binary immediately on an existing note — fine (note already committed). If the attachments plan isn't landed, gate this button behind a feature check or ship the toolbar without it first.
- **VALIDATE**: pick image in edit mode → embed appears → Save → RecentDetail Attachments card renders it (per attachments plan).

### Task 5: Optional live preview
- **ACTION**: A "Preview" toggle rendering the current `draft` via `<Markdown>`.
- **IMPLEMENT**: `const [preview, setPreview] = useState(false)`; when on, render `<Markdown style={markdownStyle(theme)}>{stripFrontmatter(draft)}</Markdown>` below the editor.
- **MIRROR**: RecentDetailScreen markdown render (547-553), `markdownStyle` (661-703).
- **GOTCHA**: strip frontmatter for preview only; never alter `draft`.
- **VALIDATE**: toggle shows formatted preview matching saved render.

---

## Step-by-Step Tasks (Phase 2 — WYSIWYG, deferred)

### Task 6: Dependencies + native rebuild
- **ACTION**: Add WebView + TenTap + a tiptap-markdown extension.
- **IMPLEMENT**: `npx expo install react-native-webview` then `npm i @10play/tentap-editor` (+ the chosen markdown extension, e.g. `@tiptap/markdown` or `tiptap-markdown`, bundled into the editor web build).
- **GOTCHA**: new native module → `npx expo prebuild` + full release build + **dev client** for full TenTap features (Expo Go only does basic). See memory [[native-plugin-kotlin-verification]]; never `expo install --fix` ([[expo-doctor-worklets-downgrade-trap]]).
- **VALIDATE**: app builds; a bare TenTap editor renders in a dev/release build.

### Task 7: `WysiwygEditor.tsx` — markdown-in/markdown-out via the WebView
- **ACTION**: A component that takes a markdown body string and emits an edited markdown body string.
- **IMPLEMENT**: `useEditorBridge` with the tiptap-markdown extension bundled in the WebView; on mount call `editor.setMarkdown(body)` (or `markdown.parse`); expose `getMarkdown()` for save. Props `{ value: string; onChangeMarkdown: (md: string) => void }`. **All** conversion happens in the WebView; RN passes/receives only markdown strings.
- **MIRROR**: TenTap docs `useEditorBridge`/`bridgeExtensions`.
- **GOTCHA**: do NOT use `turndown`/jsdom on the RN side. Bundle the markdown extension into the editor web asset. Enable extensions for every construct carnet uses (headings, bold/italic, bullet/ordered/**task** lists, code/fence, links, images) or they become data-loss.
- **VALIDATE**: load a note body → edit → `getMarkdown()` returns clean markdown; identity tests (Task 10) pass.

### Task 8: `splitFrontmatter` + reattach
- **ACTION**: Keep YAML frontmatter completely out of the WYSIWYG editor.
- **IMPLEMENT**: Add `export function splitFrontmatter(md): { header: string; body: string }` (raw header incl. fences) using the existing `\n---` scan. On open: feed only `body` to `WysiwygEditor`. On save: `updateNote(filepath, header + editedBody)` (preserve the exact separator the original used).
- **MIRROR**: `stripFrontmatter` (writer.ts:492-499).
- **GOTCHA**: the #1 documented corruption is frontmatter collapsing — never let the editor see it; reassemble byte-exact (preserve trailing newline of the header).
- **VALIDATE**: a note with frontmatter → edit body in WYSIWYG → save → frontmatter block byte-identical.

### Task 9: Settings toggle + edit-mode switch
- **ACTION**: Gate WYSIWYG behind an off-by-default experimental flag.
- **IMPLEMENT**: add `richEditorEnabled: boolean` to Settings (default false; mirror an existing boolean like `autoTranscribeOnSave`); add a SettingsScreen toggle "Rich editor (experimental)"; in RecentDetail edit mode, render `WysiwygEditor` when enabled else the Phase 1 TextInput+toolbar.
- **MIRROR**: settings.ts boolean handling (37-59, 167-200); SettingsScreen toggle pattern.
- **GOTCHA**: when off, behavior is exactly Phase 1 — no WebView mounted.
- **VALIDATE**: toggle flips editor type; off path unaffected.

### Task 10: Round-trip identity tests (the gate)
- **ACTION**: Prove md→editor→md doesn't mangle real notes before exposing the toggle.
- **IMPLEMENT**: `markdownRoundTrip.test.ts` with a corpus covering frontmatter (split case), headings, **nested** lists, **task** lists, image embeds `![](../Photos/x)`, code fences, inline code, links, hard line breaks. Assert serialize(parse(md)) preserves semantics (normalize only whitespace you deliberately accept). Where the WebView can't run in vitest, test the extension config / a Node-side equivalent of the same tiptap+markdown pipeline.
- **MIRROR**: writer.test.ts round-trip (475-489).
- **GOTCHA**: documented losses — task lists, nested lists, `<br>`, frontmatter, escaping. Each must have a passing case or be explicitly listed as a known limitation in-app.
- **VALIDATE**: all corpus cases pass; failures block enabling the feature.

### Task 11: On-device WYSIWYG QA
- **ACTION**: Verify on the Pixel against real notes.
- **VALIDATE**: edit varied notes via WYSIWYG, save, confirm `<Markdown>` re-render matches and the raw `.md` stays clean (diff before/after); confirm frontmatter untouched.

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected | Edge? |
|---|---|---|---|
| `wrapSelection` toggle | "x", sel over x, `**` | `**x**`; again → `x` | yes |
| `wrapSelection` empty | "", cursor, `*` | `**` cursor between | yes |
| `prefixLines` multi | 3 selected lines, `- ` | each line prefixed | yes |
| `prefixLines` ordered | 3 lines, `1. ` | `1.`/`2.`/`3.` | yes |
| `insertAtCursor` link | draft+sel, `[t](u)` | inserted, cursor placed | no |
| `splitFrontmatter` (P2) | md with YAML | `{header,body}`, header byte-exact | yes |
| round-trip frontmatter (P2) | YAML + body | header preserved verbatim | yes |
| round-trip task/nested list (P2) | `- [ ]` + nested | preserved or flagged | yes |
| round-trip image embed (P2) | `![](../Photos/x)` | path not rewritten/escaped | yes |

### Edge Cases Checklist
- [ ] Selection at start / end of document
- [ ] Toggle formatting off (unwrap)
- [ ] Multi-line block prefix across mixed lines
- [ ] Frontmatter-only note (empty body)
- [ ] Note with no frontmatter
- [ ] Image embed + code fence survive round-trip (P2)
- [ ] SAF `content://` note saves correctly
- [ ] Cancel edit discards (dirty guard intact)

---

## Validation Commands

### Static Analysis
```bash
cd apps/mobile && npx tsc --noEmit
```
EXPECT: Zero type errors

### Unit Tests
```bash
cd apps/mobile && npx vitest run src/lib/markdownEdit.test.ts        # P1
cd apps/mobile && npx vitest run src/lib/markdownRoundTrip.test.ts   # P2 (gate)
```
EXPECT: All pass (P2 gate must be green before enabling the toggle)

### Full Test Suite
```bash
cd apps/mobile && npx vitest run
```
EXPECT: No regressions (currently 223 passing)

### Build
```bash
cd apps/mobile && npm run android:release    # P2 requires this (new native module); P1 is JS-only
```
EXPECT: BUILD SUCCESSFUL

### Manual / On-device
- [ ] P1: select text → Bold/H2/List/Checkbox/Link → correct markdown; Save persists; re-render matches
- [ ] P1: insert image in edit mode → embed + Attachments card render
- [ ] P2: enable toggle → WYSIWYG edits a note → Save → raw `.md` stays clean, frontmatter byte-identical

---

## Acceptance Criteria
- [ ] P1 toolbar wraps/prefixes/inserts markdown around the selection with sane cursor behavior
- [ ] P1 insert-image works in edit mode (composes with attachments)
- [ ] P1 optional live preview matches saved render
- [ ] P2 WYSIWYG round-trips to clean markdown; frontmatter never altered
- [ ] P2 gated behind off-by-default experimental toggle + passing identity tests
- [ ] tsc clean, full vitest green, release build succeeds (P2)

## Completion Checklist
- [ ] Pure helpers tested; immutable returns (text + selection)
- [ ] Reuses existing edit mode / `updateNote` / `markdownStyle` (no parallel edit path)
- [ ] No `turndown`/DOM-shim on RN side; conversion inside the WebView (P2)
- [ ] Frontmatter split + reattached verbatim (P2)
- [ ] Identity tests cover documented corruption modes (P2)
- [ ] Native rebuild verified on-device (P2)
- [ ] No scope creep (no format change, no collab, no default-on WYSIWYG)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WYSIWYG round-trip corrupts `.md` (frontmatter/lists/escaping) | **High** (documented) | **High** | Split frontmatter; in-WebView tiptap-markdown; identity-test gate; off by default |
| New native module (webview/tentap) breaks build | Med | High | `npx expo install`, full release build + dev client, never `--fix` |
| Controlled `selection` jitters with IME (P1) | Med | Med | Set selection only post-action; let `onSelectionChange` own it otherwise |
| TenTap needs dev client; Expo Go insufficient | High | Low | Use release/dev-client build for QA (already the norm here) |
| Relative image paths rewritten by serializer (P2) | Med | Med | Image-embed identity test; keep image nodes verbatim |
| Scope balloons into capture-time rich editing | Low | Med | Explicitly scoped to RecentDetail edit mode |

## Notes
- **Why phased:** the existing edit mode is a plain markdown TextInput, so a formatting toolbar is a small, zero-risk upgrade that delivers most of the "rich text" value immediately; true WYSIWYG carries real, *documented* `.md`-corruption risk and a WebView native dependency, so it's correctly the deferred "later" phase — exactly as requested.
- **Architecture decision (P2):** markdown stays source of truth; `@tiptap/markdown` does md↔editor conversion *inside* the WebView so the RN/Hermes side only ever exchanges markdown strings (no `turndown`, no jsdom). Frontmatter is split off before editing and reattached byte-exact.
- **Alternatives considered:** `react-native-pell-rich-editor` (older/lighter, HTML-centric, no markdown advantage); Lexical-RN (not production-ready); markdown+toolbar only (Phase 1 — recommended first cut). TenTap chosen for Phase 2 as the most mature, New-Arch-ready RN WYSIWYG.
- Composes with `rich-content-attachments.plan.md` (shared image-insert path). Land that first to get `pickAttachment`/`writeBinary` for the toolbar's image button.
```

