import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // These suites are filesystem tests: every write is a real fsync + rename
    // through a temporary knowledge base. They run in ~1s locally, but the
    // margin under the 5s default is wall-clock on a shared CI disk, not
    // compute — one loaded runner has already blown through it. Headroom, not
    // a fix: the reason that timeout was reachable at all (redundant
    // re-initialization) is fixed in storage/repository.ts, and a genuinely
    // stuck test still fails here, just later.
    testTimeout: 20_000,
  },
});
