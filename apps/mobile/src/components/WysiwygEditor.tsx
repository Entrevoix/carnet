import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { RichText, Toolbar, useEditorBridge, TenTapStartKit } from '@10play/tentap-editor';
import { editorHtml } from '../../editor-web/generated/editorHtml';
import { MarkdownBridge, awaitMarkdownResponse } from '../bridges/MarkdownBridge';

export interface WysiwygEditorRef {
  /** Resolve the current editor content as a markdown string (read on save). */
  getMarkdown: () => Promise<string>;
}

interface WysiwygEditorProps {
  /** Initial markdown body (frontmatter already split off by the caller). */
  value: string;
}

/**
 * WYSIWYG note-body editor backed by TenTap (TipTap inside a WebView). Only ever
 * exchanges MARKDOWN — carnet's on-disk source of truth — via MarkdownBridge.
 * The caller injects the body once on mount and reads the edited body back on
 * demand through the imperative getMarkdown() handle.
 */
export const WysiwygEditor = forwardRef<WysiwygEditorRef, WysiwygEditorProps>(
  function WysiwygEditor({ value }, ref) {
    const editor = useEditorBridge({
      customSource: editorHtml,
      // Give the WebView a real origin; without a baseUrl, Android loads with a
      // null origin and the bundle's <script type="module"> can be blocked.
      webviewBaseURL: 'https://localhost/',
      bridgeExtensions: [...TenTapStartKit, MarkdownBridge],
      autofocus: false,
      avoidIosKeyboard: true,
      // initialContent is HTML-only; the markdown body is injected after mount
      // via editor.setMarkdown (markdown passed here would be parsed as HTML).
      initialContent: '<p></p>',
    });
    const initializedRef = useRef(false);

    // Inject the note body once the editor is live. A setMarkdown sent before the
    // WebView bridge is listening is silently dropped, and the ~800 KB bundle's
    // cold start can outlast a blind timer — so anchor to the WebView load event
    // (onLoad below) and re-send across a short staircase. Runs once, before any
    // user edit; setMarkdown is idempotent.
    const injectBody = useCallback(() => {
      if (initializedRef.current) return;
      initializedRef.current = true;
      [100, 400, 900].forEach((delay) =>
        setTimeout(() => editor.setMarkdown(value), delay),
      );
    }, [editor, value]);

    // Fallback in case the WebView onLoad never fires.
    useEffect(() => {
      const timer = setTimeout(injectBody, 2500);
      return () => clearTimeout(timer);
    }, [injectBody]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          const response = awaitMarkdownResponse();
          editor.requestMarkdown();
          return response;
        },
      }),
      [editor]
    );

    return (
      <View style={styles.container}>
        <RichText editor={editor} onLoad={injectBody} />
        <Toolbar editor={editor} />
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: { flex: 1 },
});
