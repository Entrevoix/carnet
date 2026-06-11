// @vitest-environment jsdom
//
// Security gate for the WYSIWYG paste path (PR #35 review open question).
//
// Pasting plain text routes through editor.commands.insertContent(text,
// { contentType: 'markdown' }) — marked (gfm) -> tiptap schema. tiptap renders
// through ProseMirror's schema-constrained DOM (never innerHTML), and the schema
// has no <script> node, so a pasted raw-HTML payload must NOT reach the live
// editor DOM as an executable element. This proves that, since it can't be
// exercised on the release device (adb can't inject the clipboard).

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

// Run the payload through the same markdown parser the editor uses for BOTH
// body-load (setMarkdown -> setContent) and paste (insertContent), rendering it
// to a live ProseMirror DOM. The parser + schema are shared, so this proves the
// neutralization for the paste path too. (We construct from markdown rather than
// insertContent at a cursor only to avoid the inline-cursor block-insert schema
// check, which is a position concern, not a parsing/safety one.)
function renderMarkdown(payload: string): Editor {
  return new Editor({ extensions: EXTENSIONS, content: payload, contentType: 'markdown' });
}

describe('WYSIWYG markdown parser cannot inject executable HTML', () => {
  it('a <script> in markdown becomes inert text, never a live <script> element', () => {
    const editor = renderMarkdown('hello <script>alert(1)</script> world');
    expect(editor.view.dom.querySelector('script')).toBeNull();
    // ...and re-serialization must not reintroduce an executable script element.
    const md = (editor as unknown as { getMarkdown: () => string }).getMarkdown();
    expect(md).not.toMatch(/<script\b/i);
    editor.destroy();
  });

  it('an <img onerror> in markdown carries no event-handler attribute in the DOM', () => {
    const editor = renderMarkdown('an image: <img src=x onerror="alert(1)">');
    editor.view.dom
      .querySelectorAll('img')
      .forEach((img) => expect(img.getAttribute('onerror')).toBeNull());
    editor.destroy();
  });
});
