import { BridgeExtension } from '@10play/tentap-editor';
import type { Editor } from '@tiptap/core';
import { resolveMarkdownResponse } from './markdownResponse';
import { resolveContentAck } from './markdownAck';

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
  | { type: 'insert-markdown'; payload: string }
  | { type: 'set-image-src'; payload: { rel: string; dataUri: string } }
  | { type: 'request-markdown'; payload?: undefined }
  | { type: 'markdown-response'; payload: string }
  | { type: 'content-ack'; payload: number };

/** The markdown-only surface @tiptap/markdown adds to the editor on the web side. */
interface WebMarkdownEditor {
  getMarkdown: () => string;
  commands: {
    setContent: (content: string, options: { contentType: 'markdown' }) => boolean;
    // insertContent at the cursor — the same markdown-aware path MarkdownPaste
    // already uses, reused here to drop an image embed in at the caret.
    insertContent: (content: string, options: { contentType: 'markdown' }) => boolean;
  };
}

/** Swap the display src of every image node whose canonical path matches `rel`
 * (the freshly-injected canonical src, or — for an idempotent re-swap — the title
 * we stashed it in) to `dataUri`, keeping the canonical path in the title so
 * getMarkdown still serializes `![alt](dataUri "rel")` and restoreImagesFromEditor
 * rebuilds the clean `![alt](rel)` on save. A leaf image node carries no content,
 * so setNodeMarkup only rewrites its attrs. Returns true if anything changed. */
function swapImageSrc(editor: Editor, rel: string, dataUri: string): boolean {
  return editor.commands.command(({ tr, state, dispatch }) => {
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (
        node.type.name === 'image' &&
        (node.attrs.src === rel || node.attrs.title === rel)
      ) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: dataUri, title: rel });
        changed = true;
      }
    });
    if (changed && dispatch) dispatch(tr);
    return changed;
  });
}

// The in-flight requestMarkdown() reply is owned by markdownResponse.ts, and the
// body-applied content-ack by markdownAck.ts (both dependency-free so their
// timeout/cleanup logic is unit-testable without loading this TenTap bridge
// headless). Re-exported so callers keep importing them from here.
export { awaitMarkdownResponse } from './markdownResponse';
export { onceContentAck } from './markdownAck';

export interface MarkdownBridgeInstance {
  setMarkdown: (markdown: string) => void;
  insertMarkdown: (markdown: string) => void;
  /** Swap one already-injected `../Photos/<file>` embed to its `data:` URI for
   * in-editor preview — one bounded message per image, so a note's images never
   * compound into one oversized payload (issue #43). */
  setImageSrc: (rel: string, dataUri: string) => void;
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
      // Echo back the applied body length. The RN side gates "the body really
      // landed" on receiving this — proof the injection wasn't silently dropped
      // (issue #43) — before it swaps images in or reads the body back on save.
      sendMessageBack({ type: 'content-ack', payload: web.getMarkdown().length });
      return true;
    }
    if (message.type === 'insert-markdown') {
      // Parse the payload as markdown and drop it in at the cursor (used to
      // insert an image embed). Same contentType:'markdown' requirement as
      // set-markdown — without it the string is inserted as literal HTML.
      web.commands.insertContent(message.payload, { contentType: 'markdown' });
      return true;
    }
    if (message.type === 'set-image-src') {
      swapImageSrc(editor, message.payload.rel, message.payload.dataUri);
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
      resolveMarkdownResponse(message.payload);
      return true;
    }
    if (message.type === 'content-ack') {
      resolveContentAck(message.payload);
      return true;
    }
    return false;
  },

  // ── RN side: methods merged onto the editor bridge instance ──
  extendEditorInstance: (sendBridgeMessage) => ({
    setMarkdown: (markdown: string) =>
      sendBridgeMessage({ type: 'set-markdown', payload: markdown }),
    insertMarkdown: (markdown: string) =>
      sendBridgeMessage({ type: 'insert-markdown', payload: markdown }),
    setImageSrc: (rel: string, dataUri: string) =>
      sendBridgeMessage({ type: 'set-image-src', payload: { rel, dataUri } }),
    requestMarkdown: () => sendBridgeMessage({ type: 'request-markdown' }),
  }),
});
