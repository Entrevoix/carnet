# Proposal: minimal ESLint scope (decision doc — awaiting CONFIRM)

Status: draft (awaiting CONFIRM)
Date: 2026-07-18
Origin: the "no lint" gap is deliberate (CLAUDE.md) and gated on a scope
discussion. This is that discussion's input — a concrete, evidence-based
minimal scope, so the decision is approve/reject/amend rather than open-ended.

## What the existing gates already cover (don't duplicate)

`tsc --noEmit` runs with `strict`, `noUnusedLocals`, `noUnusedParameters` —
so unused code, implicit any, and null-safety are covered. 1076 vitest tests
cover behavior. Style/formatting has never been a source of defects here and
is explicitly OUT of this proposal (no prettier, no stylistic rules).

## Evidence: the defect classes that actually recur in this repo

1. **React hook mistakes** — two auto-memory entries exist precisely because
   these bit us: hooks below early returns (hook-order crash on second
   render), and effect-dependency mistakes. tsc cannot catch either.
   → `react-hooks/rules-of-hooks` (error), `react-hooks/exhaustive-deps` (warn).
2. **Unhandled floating promises** — the 2026-07-16 quality audit found SEVEN
   silently-swallowed async failure sites (Settings save, clear-key, two
   refresh handlers, permission request, model download, double-goBack), each
   fixed by hand. tsc cannot catch these; the typed lint rule catches every
   one mechanically.
   → `@typescript-eslint/no-floating-promises` (error, typed linting).

That's the whole proposed rule set: **three rules**, each mapped to a defect
class with a named incident. Nothing else — no import ordering, no naming, no
complexity metrics, no stylistic anything.

## Cost / mechanics

- Deps (mobile workspace only): `eslint`, `typescript-eslint`,
  `eslint-plugin-react-hooks`. Flat config (`eslint.config.mjs`), scoped to
  `apps/mobile/src/**` (+ `App.tsx`); desktop stays out until its fate is
  decided; packages/shared has no hooks/promises patterns worth the setup.
- Typed linting (`no-floating-promises` needs the TS program) costs CI time:
  estimate +30-60s inside the existing `mobile` job — well inside the current
  ~17-21min wall clock (dominated by mobile-android).
- New script `npm -w @carnet/mobile run lint`; added to the `mobile` CI job
  (thus the required gate) only AFTER the repo lints clean — first PR fixes
  or explicitly `// eslint-disable`s (with reasons) any existing findings.
- CLAUDE.md's "there is no lint" paragraphs updated in the same PR.

## Expected first-run findings (honest guess)

`exhaustive-deps` will flag some deliberately-narrow dep arrays (the screens
use them intentionally in places) — those get targeted disable comments with
reasons, which is itself documentation. `no-floating-promises` will flag the
repo's `void someAsync()` convention — the `ignoreVoid: true` option keeps
that idiom legal, so only genuinely-forgotten awaits surface.

## Decision requested

- **Approve** → one PR implementing exactly the above (devils-advocate loop +
  CI gate as mandated).
- **Amend** → edit the rule list here first.
- **Reject** → the gap stays deliberate; this doc moves to plans/completed/
  with a "rejected" status so the backlog item stops resurfacing.
