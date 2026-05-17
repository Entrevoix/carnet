import { defineConfig } from "vitest/config";
import path from "node:path";

const stubDir = path.resolve(__dirname, "test/__stubs__");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Native-only modules whose real source is Flow-typed or otherwise
      // unparseable by Rollup. Each gets its own stub so vitest treats them
      // as distinct modules. expo-file-system and expo-secure-store are
      // intentionally NOT aliased; existing tests vi.mock them directly.
      "expo-sqlite": path.join(stubDir, "expo-sqlite.ts"),
      "expo-haptics": path.join(stubDir, "expo-haptics.ts"),
    },
  },
});
