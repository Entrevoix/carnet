import { defineConfig } from "vitest/config";
import path from "node:path";

const stubDir = path.resolve(__dirname, "test/__stubs__");

export default defineConfig({
  // Screen tests use JSX without importing React (RN's babel preset does the
  // same in the app); esbuild defaults to the classic runtime, so opt into
  // the automatic one.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // .test.tsx = screen/component smoke tests; they opt into jsdom per-file
    // via `// @vitest-environment jsdom` (see markdownPasteSafety.test.ts for
    // the precedent).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/fixtures/**/*.test.ts"],
    server: {
      deps: {
        // Externalized deps are loaded with plain Node require, which
        // bypasses the react-native → react-native-web alias below — so
        // react-native-paper's internal require("react-native") would hit
        // the real Flow-typed react-native and throw a SyntaxError. Inline
        // the whole react-native family so vite processes (and aliases)
        // their imports.
        inline: [/react-native/],
      },
    },
  },
  resolve: {
    alias: {
      // react is nested under apps/mobile while react-dom hoists to the repo
      // root; two React copies = "Cannot read properties of null (reading
      // 'useState')" the moment a component renders. Externalized react-dom
      // natively requires the ROOT react, so pin every react import there
      // (dedupe would pick the nested copy — the wrong one).
      react: path.resolve(__dirname, "../../node_modules/react"),
      "react-dom": path.resolve(__dirname, "../../node_modules/react-dom"),
      // Screen smoke tests render the real component tree in Node: react-native
      // resolves to react-native-web (react-native's own source is Flow-typed
      // and unparseable by Rollup). Pixels/native behavior stay on-device.
      "react-native": "react-native-web",
      // Paper's default entry is its CommonJS build, whose internal
      // require("react-native") executes natively and bypasses the alias
      // above (→ Flow SyntaxError). Its ESM build's imports go through
      // vite's transform, where the alias applies.
      "react-native-paper": path.resolve(
        __dirname,
        "../../node_modules/react-native-paper/lib/module/index.js",
      ),
      // Probes a native TurboModule at import time (via PaperProvider);
      // the stub reports zero insets.
      "react-native-safe-area-context": path.join(
        stubDir,
        "react-native-safe-area-context.tsx",
      ),
      // Native-only modules whose real source is Flow-typed or otherwise
      // unparseable by Rollup. Each gets its own stub so vitest treats them
      // as distinct modules. Tests still `vi.mock(...)` on top for
      // specific behavior.
      "expo-sqlite": path.join(stubDir, "expo-sqlite.ts"),
      "expo-haptics": path.join(stubDir, "expo-haptics.ts"),
      // expo-file-system/legacy was previously left to vi.mock alone, but
      // its src pulls in expo-modules-core → react-native (Flow), so
      // rollup's native parser crashes before vi.mock can intercept.
      // Aliasing the legacy entry to a plain-TS stub keeps the resolution
      // chain inside files vite-node can parse.
      "expo-file-system/legacy": path.join(stubDir, "expo-file-system-legacy.ts"),
      // expo-location -> expo-modules-core -> react-native (Flow), unparseable
      // by Rollup. Stub it so the pure coord helpers are testable.
      "expo-location": path.join(stubDir, "expo-location.ts"),
    },
  },
});
