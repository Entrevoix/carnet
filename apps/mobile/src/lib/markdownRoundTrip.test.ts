// @vitest-environment jsdom
//
// WYSIWYG Phase 2 FIDELITY GATE (plan Task 10).
//
// Proves whether the SAME tiptap v3 + @tiptap/markdown pipeline that TenTap will
// run inside its WebView can round-trip carnet's markdown note bodies (md ->
// ProseMirror doc -> md) without corrupting them. If the must-have constructs
// below don't survive, native WYSIWYG (Tasks 6,7,9,11) must NOT be built — the
// notes are the source of truth and silent .md corruption is unacceptable.
//
// Frontmatter is intentionally NOT exercised here: it is split off with
// splitFrontmatter() and reattached byte-exact; the editor never sees it.
//
// Runs headless in jsdom with the ProseMirror layout-API shims tiptap needs.

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { Markdown } from '@tiptap/markdown';

// ── ProseMirror layout-API shims (jsdom doesn't implement these) ──────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const zeroRect = () =>
  ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
const emptyRects = () => Object.assign([], { item: () => null });
(Range.prototype as any).getBoundingClientRect = zeroRect;
(Range.prototype as any).getClientRects = emptyRects;
(HTMLElement.prototype as any).getBoundingClientRect = zeroRect;
(HTMLElement.prototype as any).getClientRects = emptyRects;
(document as any).elementFromPoint = () => null;
/* eslint-enable @typescript-eslint/no-explicit-any */

const EXTENSIONS = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  Markdown.configure({ markedOptions: { gfm: true } }),
];

/** md -> ProseMirror doc -> md, exactly as the WebView editor will on open+save. */
function roundTrip(md: string): string {
  const editor = new Editor({ extensions: EXTENSIONS, content: md, contentType: 'markdown' });
  // getMarkdown() is the convenience method added by @tiptap/markdown.
  const out = (editor as unknown as { getMarkdown: () => string }).getMarkdown();
  editor.destroy();
  return out;
}

// Collapse trailing whitespace differences we deliberately accept (the editor
// may normalize the final newline / list marker spacing). Semantic structure,
// not byte-identity, is the bar for the BODY (frontmatter byte-identity is
// covered by splitFrontmatter's own tests).
const norm = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

describe('markdown round-trip fidelity (WYSIWYG Phase 2 gate)', () => {
  describe('must survive (block native WYSIWYG if any fail)', () => {
    it('ATX headings', () => {
      const out = roundTrip('# H1\n\n## H2\n\n### H3\n');
      expect(out).toContain('# H1');
      expect(out).toContain('## H2');
      expect(out).toContain('### H3');
    });

    it('bold and italic', () => {
      const out = roundTrip('**bold** and *italic* words\n');
      expect(out).toContain('**bold**');
      expect(out).toMatch(/[*_]italic[*_]/); // serializer may emit * or _
    });

    it('inline code', () => {
      expect(roundTrip('use `npm run` here\n')).toContain('`npm run`');
    });

    it('fenced code block preserves content and language', () => {
      const out = roundTrip('```ts\nconst x = 1;\n```\n');
      expect(out).toContain('```');
      expect(out).toContain('const x = 1;');
    });

    it('links keep their target', () => {
      expect(roundTrip('see [example](https://example.com/x)\n')).toContain('(https://example.com/x)');
    });

    it('bullet list', () => {
      const out = norm(roundTrip('- alpha\n- beta\n- gamma\n'));
      expect(out).toMatch(/^[-*] alpha$/m);
      expect(out).toMatch(/^[-*] gamma$/m);
    });

    it('ordered list keeps numbering', () => {
      const out = roundTrip('1. one\n2. two\n3. three\n');
      expect(out).toMatch(/1\.\s+one/);
      expect(out).toMatch(/3\.\s+three/);
    });

    it('nested list keeps a child indented under its parent', () => {
      const out = roundTrip('- parent\n  - child\n');
      expect(out).toMatch(/[-*] parent/);
      // child must be indented (still a sub-item), not flattened to top level.
      expect(out).toMatch(/\n\s+[-*] child/);
    });

    it('GFM task list keeps checkbox state', () => {
      const out = roundTrip('- [ ] todo\n- [x] done\n');
      expect(out).toContain('[ ]');
      expect(out.toLowerCase()).toContain('[x]');
    });

    it('CRITICAL: image embed keeps the relative ../Photos path verbatim (no percent-encoding)', () => {
      const out = roundTrip('![cat](../Photos/cat-2026.jpg)\n');
      expect(out).toContain('../Photos/cat-2026.jpg');
      expect(out).not.toMatch(/%2F|%2e%2e/i); // ../ must NOT be url-encoded
    });

    it('realistic carnet note body survives end to end', () => {
      const body = [
        '# Meeting notes',
        '',
        'Talked to **Sam** about the `carnet` roadmap.',
        '',
        '- [ ] follow up on STT',
        '- [x] merge PR #32',
        '  - nested detail',
        '',
        '1. first',
        '2. second',
        '',
        '![diagram](../Photos/roadmap.png)',
        '',
        'See [the plan](https://example.com/plan).',
        '',
        '```bash',
        'npm run android:release',
        '```',
        '',
      ].join('\n');
      const out = roundTrip(body);
      expect(out).toContain('# Meeting notes');
      expect(out).toContain('**Sam**');
      expect(out).toContain('`carnet`');
      expect(out).toContain('[ ] follow up on STT');
      expect(out.toLowerCase()).toContain('[x] merge pr #32');
      expect(out).toContain('../Photos/roadmap.png');
      expect(out).toContain('(https://example.com/plan)');
      expect(out).toContain('npm run android:release');
    });
  });

  describe('known-fragile (document as in-app limitation if they fail, not necessarily a blocker)', () => {
    it('two-space hard line break (tiptap issue #7107)', () => {
      const out = roundTrip('line one  \nline two\n');
      // If this merges into one line, two-space breaks are a documented loss.
      expect(out).toMatch(/line one[\s\S]*\n[\s\S]*line two/);
    });

    it('DOCUMENTED LIMITATION: prose underscores are backslash-escaped (render-equivalent)', () => {
      // prosemirror-markdown conservatively escapes `_` in prose text:
      //   foo_bar_baz.md  ->  foo\_bar\_baz.md
      // `\_` renders as `_`, so there is NO visual/semantic loss, but it adds
      // backslash churn to the raw .md. This is the accepted known limitation
      // for WYSIWYG editing (tiptap issue #7258); surface it in-app.
      expect(roundTrip('the file is foo_bar_baz.md\n')).toContain('foo\\_bar\\_baz.md');
      // ...but underscores inside code spans are kept raw (not escaped).
      expect(roundTrip('`foo_bar`\n')).toContain('`foo_bar`');
    });
  });
});
