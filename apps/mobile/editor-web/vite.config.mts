import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// Resolve the ONE react/react-dom we want bundled (the app's React 19 pair) and
// alias to their absolute dirs. `resolve.dedupe` proved non-deterministic here:
// some builds resolved react-dom to TenTap's nested react-dom@18.3.1 instead of
// the root 19.1.0, which crashes React 19 at runtime ("Cannot read properties of
// undefined (reading 'ReactCurrentBatchConfig')"). Absolute-path aliases force a
// single, correct copy every build.
const require = createRequire(import.meta.url);
const reactDir = dirname(require.resolve('react/package.json'));
const reactDomDir = dirname(require.resolve('react-dom/package.json'));

// Builds the TenTap WebView editor (editor-web/index.tsx) into ONE self-contained
// index.html (viteSingleFile), which buildEditor.js then bakes into editorHtml.js.
// .mts so vite loads it as ESM. esbuild handles the automatic React JSX runtime.
export default defineConfig({
  root: 'editor-web',
  build: {
    // NOT "build"/"dist" — those are globally gitignored; editorHtml.js must be a
    // committed, tracked artifact so the RN app builds without Vite.
    outDir: 'generated',
    emptyOutDir: false,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: [
      // String finds → react-dom BEFORE react ('react' won't match 'react-dom').
      // These catch subpaths too (react-dom/client, react/jsx-runtime).
      { find: 'react-dom', replacement: reactDomDir },
      { find: 'react', replacement: reactDir },
      // Official TenTap recipe: swap the RN entry for the /web build, and force
      // ProseMirror EditorView/EditorState to TenTap's bundled singletons.
      { find: '@10play/tentap-editor', replacement: '@10play/tentap-editor/web' },
      { find: '@tiptap/pm/view', replacement: '@10play/tentap-editor/web' },
      { find: '@tiptap/pm/state', replacement: '@10play/tentap-editor/web' },
    ],
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  plugins: [viteSingleFile()],
  server: { port: 3000 },
});
