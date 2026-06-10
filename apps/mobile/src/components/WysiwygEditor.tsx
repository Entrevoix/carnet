import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { RichText, Toolbar, useEditorBridge, TenTapStartKit } from '@10play/tentap-editor';
import { editorHtml } from '../../editor-web/generated/editorHtml';
import { MarkdownBridge, awaitMarkdownResponse } from '../bridges/MarkdownBridge';

// Higher-contrast toolbar icons than TenTap's washed-out greys. Deep-merged over
// the default theme by useEditorBridge (lodash merge), so only these keys change:
// active icons go near-black, and the disabled state (shown whenever the editor
// isn't focused) stays clearly visible instead of fading to a faint #CACACA.
const EDITOR_THEME = {
  toolbar: {
    icon: { tintColor: '#1F2430' },
    iconDisabled: { tintColor: '#8A9099' },
    iconWrapperDisabled: { opacity: 0.55 },
  },
};

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
      // Darken the toolbar icons. TenTap's defaults are low-contrast greys
      // (#898989 active, #CACACA @ 0.3 opacity when disabled) which read as
      // "greyed out" against the white bar; deep-merged over the defaults.
      theme: EDITOR_THEME,
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
        {/* Formatting toolbar (bold/italic/headings/lists/code/link/quote) docked at
            the TOP of the editor, always visible. TenTap's Toolbar auto-hides when the
            keyboard is down (hidden===undefined), so we force hidden={false}.
            We dock it at the top rather than floating above the keyboard: the
            above-keyboard approach needs a native keyboard-inset module
            (react-native-keyboard-controller) whose transitive Google-Maven deps
            can't be fetched in this build environment. RN's own Keyboard height
            under-reports the Android edge-to-edge IME (it omits the suggestion strip),
            so a JS-only above-keyboard dock would tuck the toolbar behind that strip. */}
        <View style={styles.toolbarBar}>
          <Toolbar editor={editor} hidden={false} />
        </View>
        <View style={styles.editor}>
          <RichText editor={editor} onLoad={injectBody} />
        </View>
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Pin the toolbar to a single row. TenTap's toolbarBody has flex:1, so as a
  // flex-column child it would otherwise balloon to fill half the screen; a
  // fixed-height parent forces it to its intended ~48px row.
  toolbarBar: { height: 48 },
  editor: { flex: 1 },
});
