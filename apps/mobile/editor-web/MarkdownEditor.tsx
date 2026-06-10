import { EditorContent } from '@tiptap/react';
// At build time Vite aliases @10play/tentap-editor -> @10play/tentap-editor/web
// (see vite.config.ts); the RN entry can't bundle for the browser.
import { useTenTap, TenTapStartKit } from '@10play/tentap-editor';
import { Markdown } from '@tiptap/markdown';
import CodeBlock from '@tiptap/extension-code-block';
import { MarkdownBridge } from '../src/bridges/MarkdownBridge';

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
      ],
    },
  });

  const dynamicHeight = (window as Window & { dynamicHeight?: boolean }).dynamicHeight;
  return (
    <EditorContent editor={editor} className={dynamicHeight ? 'dynamic-height' : undefined} />
  );
};
