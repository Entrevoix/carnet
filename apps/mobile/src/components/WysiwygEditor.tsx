import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
      bridgeExtensions: [...TenTapStartKit, MarkdownBridge],
      autofocus: false,
      avoidIosKeyboard: true,
      // initialContent is HTML-only; the markdown body is injected after mount
      // via editor.setMarkdown (markdown passed here would be parsed as HTML).
      initialContent: '<p></p>',
    });
    const initializedRef = useRef(false);

    useEffect(() => {
      if (initializedRef.current) return;
      // TenTap 1.0.1 emits no "editor ready" event; the documented pattern is a
      // short post-mount delay so the WebView bridge is live before we inject.
      const timer = setTimeout(() => {
        editor.setMarkdown(value);
        initializedRef.current = true;
      }, 150);
      return () => clearTimeout(timer);
    }, [editor, value]);

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
        <RichText editor={editor} />
        <Toolbar editor={editor} />
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: { flex: 1 },
});
