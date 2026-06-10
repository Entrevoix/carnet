import { BridgeExtension } from '@10play/tentap-editor';
import type { Editor } from '@tiptap/core';

/**
 * Custom TenTap bridge that exchanges MARKDOWN (not HTML) across the WebView
 * boundary. TenTap ships no markdown bridge, and markdown is carnet's on-disk
 * source of truth, so the RN side only ever hands the editor markdown strings
 * and only ever reads markdown back.
 *
 * This module is imported by BOTH sides:
 *  - the web editor bundle (editor-web/MarkdownEditor.tsx), where @tiptap/markdown
 *    has augmented the tiptap Editor with getMarkdown() and the
 *    setContent({ contentType: 'markdown' }) option; and
 *  - the RN component (components/WysiwygEditor.tsx), where @tiptap/markdown is
 *    NOT bundled. To keep the RN type-check clean we never import
 *    @tiptap/markdown here and reach its editor surface through one explicit cast.
 */

type MarkdownMessage =
  | { type: 'set-markdown'; payload: string }
  | { type: 'request-markdown'; payload?: undefined }
  | { type: 'markdown-response'; payload: string };

/** The markdown-only surface @tiptap/markdown adds to the editor on the web side. */
interface WebMarkdownEditor {
  getMarkdown: () => string;
  commands: {
    setContent: (content: string, options: { contentType: 'markdown' }) => boolean;
  };
}

// Save-on-demand issues one requestMarkdown() at a time, so a single pending
// resolver suffices; an overlapping second request would drop the first.
let pendingResolve: ((markdown: string) => void) | null = null;

/** Call immediately before editor.requestMarkdown(); resolves when the WebView replies. */
export function awaitMarkdownResponse(): Promise<string> {
  return new Promise<string>((resolve) => {
    pendingResolve = resolve;
  });
}

export interface MarkdownBridgeInstance {
  setMarkdown: (markdown: string) => void;
  requestMarkdown: () => void;
}

declare module '@10play/tentap-editor' {
  interface EditorBridge extends MarkdownBridgeInstance {}
}

export const MarkdownBridge = new BridgeExtension<
  object,
  MarkdownBridgeInstance,
  MarkdownMessage
>({
  forceName: 'markdownBridge',

  // ── WEB side: react to messages coming from RN ──
  onBridgeMessage: (editor: Editor, message, sendMessageBack) => {
    const web = editor as unknown as WebMarkdownEditor;
    if (message.type === 'set-markdown') {
      // contentType:'markdown' is MANDATORY: without it the string is parsed as
      // HTML and silently corrupts the note. tiptap v3 signature is
      // setContent(content, options) — NOT the v2 (content, emitUpdate, options).
      web.commands.setContent(message.payload, { contentType: 'markdown' });
      return true;
    }
    if (message.type === 'request-markdown') {
      sendMessageBack({ type: 'markdown-response', payload: web.getMarkdown() });
      return true;
    }
    return false;
  },

  // ── RN side: receive the reply from the WebView ──
  onEditorMessage: (message) => {
    if (message.type === 'markdown-response') {
      pendingResolve?.(message.payload);
      pendingResolve = null;
      return true;
    }
    return false;
  },

  // ── RN side: methods merged onto the editor bridge instance ──
  extendEditorInstance: (sendBridgeMessage) => ({
    setMarkdown: (markdown: string) =>
      sendBridgeMessage({ type: 'set-markdown', payload: markdown }),
    requestMarkdown: () => sendBridgeMessage({ type: 'request-markdown' }),
  }),
});
