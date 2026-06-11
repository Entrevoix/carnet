import { EditorContent } from '@tiptap/react';
// At build time Vite aliases @10play/tentap-editor -> @10play/tentap-editor/web
// (see vite.config.ts); the RN entry can't bundle for the browser.
import { useTenTap, TenTapStartKit } from '@10play/tentap-editor';
import { Markdown } from '@tiptap/markdown';
import CodeBlock from '@tiptap/extension-code-block';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { MarkdownBridge } from '../src/bridges/MarkdownBridge';
import { markdownFromClipboard } from '../src/lib/markdownPaste';

/**
 * Paste raw markdown as formatted content. The official @tiptap/markdown (v3) has no
 * paste option (unlike the community `tiptap-markdown`'s transformPastedText), so we add
 * a ProseMirror handler: a plain-text paste (no HTML clipboard payload) is parsed as
 * markdown and inserted at the cursor; rich/HTML pastes fall through to the default
 * handler. Typing markdown shortcuts already works via TipTap input rules — this covers
 * pasting a whole markdown block at once.
 */
const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const clipboard = event.clipboardData;
            if (!clipboard) return false;
            const markdown = markdownFromClipboard(
              clipboard.getData('text/html'),
              clipboard.getData('text/plain'),
            );
            if (markdown == null) return false; // rich/HTML or empty → default handler
            event.preventDefault();
            editor.commands.insertContent(markdown, { contentType: 'markdown' });
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * The tiptap editor that runs INSIDE the TenTap WebView.
 *
 * Extensions: TenTapStartKit already registers Bold/Italic/Heading/Bullet &
 * Ordered lists/Link/inline Code/TaskList+TaskItem(nested)/Image, so re-adding
 * any of those is a tiptap v3 duplicate-extension crash. The only gaps vs the
 * proven fidelity config (markdownRoundTrip.test.ts) are:
 *   - CodeBlock — TenTapStartKit deliberately omits fenced code blocks
 *     (CodeBridge is the inline `code` mark only), which would silently drop
 *     ```fenced``` blocks; and
 *   - Markdown itself — supplies getMarkdown() + setContent contentType.
 */
export const MarkdownEditor = () => {
  const editor = useTenTap({
    bridges: [...TenTapStartKit, MarkdownBridge],
    tiptapOptions: {
      extensions: [
        CodeBlock,
        Markdown.configure({ markedOptions: { gfm: true } }), // gfm REQUIRED for "- [ ]" task parsing
        MarkdownPaste,
      ],
    },
  });

  const dynamicHeight = (window as Window & { dynamicHeight?: boolean }).dynamicHeight;
  return (
    <EditorContent editor={editor} className={dynamicHeight ? 'dynamic-height' : undefined} />
  );
};
