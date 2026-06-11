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
