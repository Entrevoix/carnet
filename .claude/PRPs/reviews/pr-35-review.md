# PR Review: #35 — WYSIWYG (rich text) note editor — TenTap, behind experimental flag

**Reviewed**: 2026-06-10
**Author**: bearyjd
**Branch**: feat/wysiwyg-native-editor → main
**Decision**: COMMENT (lean APPROVE — author cannot self-approve; feature is gated off-by-default)
**Reviewer**: oh-my-claudecode:code-reviewer (separate lane — author did not self-review)

## Summary
Opt-in WYSIWYG body editor (TenTap/TipTap in a WebView), exchanging markdown only, gated
behind `richEditorEnabled` (off by default). No CRITICAL/HIGH issues at high confidence;
correct and safe for the single-user note threat model. The MEDIUM findings are test-coverage
gaps to close before this goes on-by-default.

## Findings

### CRITICAL
None.

### HIGH
None (at high confidence).

### MEDIUM
1. **Fidelity gate tests a different extension set than ships.** `markdownRoundTrip.test.ts`
   round-trips raw `StarterKit`; the editor runs `TenTapStartKit + CodeBlock + Markdown +
   MarkdownPaste`. Fenced code blocks (the construct most at risk) aren't exercised against the
   real config. → Extract a shared `buildEditorExtensions()` consumed by both the editor and the gate.
2. **No tests for the paste handler, bridge protocol, or injection timing.** `MarkdownPaste.handlePaste`,
   the `set-markdown`/`request-markdown`/`markdown-response` protocol, and `awaitMarkdownResponse`
   have zero coverage — the highest-risk new code. → Add jsdom unit tests.
3. **Body not byte-exact across a WYSIWYG round-trip; `isDirty` always true for rich edit.** Opening
   a note and tapping Save with no changes can normalize body whitespace/list-marker spacing.
   → Compare returned markdown to the seed (post-`norm()`) and skip the write when unchanged; and/or
   document the normalization.
4. **`setMarkdown` injection uses a blind 100/400/900ms + 2500ms staircase, no ack.** A cold start
   slower than the staircase could land the body late and clobber early keystrokes. → Post an
   `editor-ready`/`markdown-applied` ack and stop on first ack; guard late timers once focused.
5. **`getMarkdown` has no try/finally to clear `pendingResolve`.** On the 5s save timeout the abandoned
   promise leaves module-level `pendingResolve` set (latent footgun if a second editor is added).
   → Reject + null out on timeout, or warn if called while a prior resolve is pending.

### LOW
1. **`injectBody` `useCallback` depends on `value` but injection is one-shot** (`initializedRef`
   blocks re-injection) — benign today (stable seed); document the mount-only semantics.
2. **Hardcoded color literals** (`#8884` borders, `#DC2626`, `#0001`) bypass the MD3 theme in
   RecentDetailScreen — use `theme.colors.outlineVariant`/`error`.
3. **Dead code: in-card rich-editor branch** (`RecentDetailScreen.tsx` ~765-768 + `wysiwygContainer`
   style) is unreachable now that `editMode && richEditorEnabled` early-returns the full-screen layout.
   → Remove it. (Quick win, worth doing in this PR.)
4. **`webviewBaseURL: 'https://localhost/'` is a real (non-owned) origin** — fine today (self-contained
   bundle, no network); if the editor ever fetches, pin an app-owned scheme + add a CSP `<meta>`.

### Open question (low confidence — surfaced, not blocking)
- **Raw HTML inside pasted markdown.** Plain-text paste routes through `insertContent(text,
  {contentType:'markdown'})` → marked (gfm) → tiptap schema. tiptap's schema-constrained parser almost
  certainly neutralizes `<script>`/`<img onerror>` (no innerHTML injection), but this wasn't executed to
  confirm. → Add a jsdom test pasting `<script>` / `<img onerror>` as plain text and assert the doc/
  `getMarkdown()` contains no executable HTML. Low threat (user's own notes), but cheap insurance.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (vitest) | Pass — 323/323, 13 files |
| Build (release APK) | Pass — on-device render verified (Pixel 9 Pro Fold) |
| Lint | N/A (no lint script) |

## Files Reviewed
- `apps/mobile/src/components/WysiwygEditor.tsx` (Modified)
- `apps/mobile/src/screens/RecentDetailScreen.tsx` (Modified)
- `apps/mobile/editor-web/MarkdownEditor.tsx` (Modified)
- `apps/mobile/src/bridges/MarkdownBridge.ts` (context)
- `apps/mobile/editor-web/generated/editorHtml.js` (built artifact — not deep-reviewed)
- `apps/mobile/src/lib/markdownRoundTrip.test.ts` (gate to align — finding 1)

## Positive notes
Intent-rich comments at every non-obvious decision; clean RN/web dual-import isolation in
MarkdownBridge; byte-exact frontmatter split/reattach; correct committed-artifact handling;
sound security posture (markdown-only across the boundary, no `dangerouslySetInnerHTML`).
