import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds the TenTap WebView editor (editor-web/index.tsx) into ONE self-contained
// index.html (viteSingleFile), which buildEditor.js then bakes into editorHtml.js.
// .mts so vite loads it as ESM. We rely on vite's built-in esbuild for the
// automatic React JSX runtime instead of @vitejs/plugin-react — this is a
// production build (no Fast Refresh needed), and dropping the plugin avoids its
// vite-version peer coupling.
//
// The aliases are the official TenTap "advanced setup" recipe and are load-bearing:
//  - @10play/tentap-editor -> /web swaps the RN entry (which pulls
//    react-native-webview, unbundlable for the browser) for the web build.
//  - @tiptap/pm/{view,state} -> /web forces ProseMirror's EditorView/EditorState
//    to be the SAME singletons TenTap's web bundle already ships, so the editor
//    created by useTenTap and the @tiptap/react <EditorContent> share one
//    ProseMirror instance (a second copy throws at runtime).
export default defineConfig({
  root: 'editor-web',
  build: {
    // NOT "build"/"dist" — those are globally gitignored; the baked editorHtml.js
    // must be a committed, tracked artifact so the RN app builds without Vite.
    outDir: 'generated',
    emptyOutDir: false,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: [
      { find: '@10play/tentap-editor', replacement: '@10play/tentap-editor/web' },
      { find: '@tiptap/pm/view', replacement: '@10play/tentap-editor/web' },
      { find: '@tiptap/pm/state', replacement: '@10play/tentap-editor/web' },
    ],
  },
  plugins: [viteSingleFile()],
  server: { port: 3000 },
});
