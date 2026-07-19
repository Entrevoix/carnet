// Minimal, evidence-based lint — scope approved 2026-07-18
// (.claude/PRPs/plans/minimal-eslint-scope.plan.md). EXACTLY three rules,
// each mapped to a defect class that has recurred in this repo; style,
// formatting, and everything else stay deliberately out. Widening this
// config needs the same scope discussion that gated its creation.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Hard scope fence: eslint must never wander into generated bundles,
    // native dirs, or the test harness — `--fix` once stripped the blanket
    // eslint-disable from editor-web/generated (a generated file) because
    // "unused". Ignores make the boundary structural, not incidental.
    ignores: [
      "editor-web/**",
      "android/**",
      "ios/**",
      ".expo/**",
      "test/**",
      "scripts/**",
      "plugins/**",
      "*.config.*",
    ],
  },
  {
    // App source only. Desktop stays unlinted until its fate is decided;
    // packages/shared has no hooks/async patterns worth the typed-lint cost.
    files: ["src/**/*.{ts,tsx}", "App.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Typed linting — required by no-floating-promises.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // Directives for rules OUTSIDE this 3-rule scope (e.g. no-explicit-any
      // annotations in tests) document intent for any future rule-widening —
      // reporting them "unused" invites --fix to delete that intent.
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Hook-order crashes (hooks below early returns) have shipped here
      // twice — tsc cannot catch them.
      "react-hooks/rules-of-hooks": "error",
      // Effect-dependency mistakes: warn, not error — the screens use
      // deliberately-narrow dep arrays in places; violations should be
      // visible and either fixed or annotated, not build-blocking.
      "react-hooks/exhaustive-deps": "warn",
      // The 2026-07-16 audit found seven silently-swallowed async failures,
      // all of this shape. ignoreVoid keeps the repo's intentional
      // `void someAsync()` fire-and-forget idiom legal.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    },
  },
);
