import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { RichText, Toolbar, useEditorBridge, TenTapStartKit } from '@10play/tentap-editor';
import { editorHtml } from '../../editor-web/generated/editorHtml';
import { MarkdownBridge, awaitMarkdownResponse } from '../bridges/MarkdownBridge';
import {
  buildCanonicalImage,
  buildEditorImage,
  resolveImagesForEditor,
  restoreImagesFromEditor,
} from '../lib/editorImages';
import { resolvePhotoDataUri } from '../lib/photoDataUri';

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
  /** Resolve the current editor content as a markdown string (read on save).
   * Editor-side `data:` image embeds are restored to canonical `../Photos/...`
   * links so the saved `.md` never carries a base64 blob. */
  getMarkdown: () => Promise<string>;
  /** Insert an image embed at the cursor. `dataUri` renders it in-editor while
   * `rel` (`../Photos/<file>`) is what serializes to disk; pass `dataUri: null`
   * to insert the canonical link without an in-editor preview (e.g. too large). */
  insertImage: (rel: string, dataUri: string | null) => void;
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
 *
 * Images need special handling: the WebView loads at https://localhost/, so a
 * note's relative `![](../Photos/x.jpg)` embed can't resolve. On the way in we
 * swap each one for an inline `data:` URI (canonical path stashed in the title);
 * on the way out we restore the canonical link. See ../lib/editorImages.
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

    // Session map of `data:` URI → canonical `../Photos/...` path, populated as
    // images are resolved on entry and inserted during the edit. It's the
    // fallback restore path if the editor ever drops our title marker (see
    // restoreImagesFromEditor); the title-carry path handles the common case.
    const imageMapRef = useRef<Map<string, string>>(new Map());

    // Resolve a relative Photos embed to a data URI for in-editor display, and
    // remember the reverse mapping. Stable identity so the resolve effect below
    // doesn't re-run.
    const resolver = useCallback(async (rel: string): Promise<string | null> => {
      const dataUri = await resolvePhotoDataUri(rel);
      if (dataUri) imageMapRef.current.set(dataUri, rel);
      return dataUri;
    }, []);

    // Injection is gated on TWO async events with no guaranteed order: the
    // WebView finishing load (onLoad) and the image-resolved body being ready.
    // tryInject fires the one-shot staircase only once both have landed.
    const resolvedRef = useRef<string | null>(null);
    const loadedRef = useRef(false);
    const initializedRef = useRef(false);
    // Flips true only once the body has actually been pushed into the editor.
    // getMarkdown() refuses to read before this so a Save tapped during cold
    // start can't pull back the empty initial content and blank the note.
    const bodyInjectedRef = useRef(false);

    const tryInject = useCallback(() => {
      if (initializedRef.current) return;
      if (!loadedRef.current || resolvedRef.current == null) return;
      initializedRef.current = true;
      const md = resolvedRef.current;
      // A setMarkdown sent before the WebView bridge is listening is silently
      // dropped, and the ~800 KB bundle's cold start can outlast a single timer,
      // so re-send across a short staircase. setMarkdown is idempotent. Mark the
      // body injected once the first push fires (content is in by then).
      [100, 400, 900].forEach((delay) =>
        setTimeout(() => {
          editor.setMarkdown(md);
          bodyInjectedRef.current = true;
        }, delay),
      );
    }, [editor]);

    // Resolve image embeds once on mount. `value` is a MOUNT-ONLY seed (the
    // caller remounts per edit session), so a later prop change is ignored. On
    // any resolve error fall back to the raw body — at worst images show broken;
    // restoreImagesFromEditor treats canonical links as no-ops, so saving stays safe.
    useEffect(() => {
      let active = true;
      resolveImagesForEditor(value, resolver)
        .then((resolved) => {
          if (!active) return;
          resolvedRef.current = resolved;
          tryInject();
        })
        .catch(() => {
          if (!active) return;
          resolvedRef.current = value;
          tryInject();
        });
      return () => {
        active = false;
      };
    }, [value, resolver, tryInject]);

    const handleLoad = useCallback(() => {
      loadedRef.current = true;
      tryInject();
    }, [tryInject]);

    // Fallback in case the WebView onLoad never fires.
    useEffect(() => {
      const timer = setTimeout(() => {
        loadedRef.current = true;
        tryInject();
      }, 2500);
      return () => clearTimeout(timer);
    }, [tryInject]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: async () => {
          // Reading before the body is injected would return the editor's empty
          // `<p></p>` seed; the caller's `next === body` short-circuit wouldn't
          // catch that, so it would overwrite the note with a blank body. Refuse
          // instead — surfaces as a Save error, mirroring "Editor not mounted".
          if (!bodyInjectedRef.current) {
            throw new Error('Editor is still loading — wait a moment and try again.');
          }
          const response = awaitMarkdownResponse();
          editor.requestMarkdown();
          const raw = await response;
          // Strip the editor-side data URIs back to canonical `../Photos/...`
          // links before the body ever touches disk.
          return restoreImagesFromEditor(raw, imageMapRef.current);
        },
        insertImage: (rel, dataUri) => {
          if (dataUri) {
            imageMapRef.current.set(dataUri, rel);
            editor.insertMarkdown(buildEditorImage('', dataUri, rel));
          } else {
            // No preview (e.g. over the inline cap): insert the canonical link.
            // It shows broken in-editor but saves + renders correctly.
            editor.insertMarkdown(buildCanonicalImage('', rel));
          }
        },
      }),
      [editor],
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
          <RichText editor={editor} onLoad={handleLoad} />
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
