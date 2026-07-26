# Session handoff — 2026-07-26 (desktop deprecation approved, implemented, CI green)

## State at handoff

Continuation of `2026-07-23-local-llm-search-phase2-desktop-decision.md`, which left the
desktop-fate decision doc (`.claude/PRPs/plans/desktop-fate.plan.md`) as the top open item
— proposed, awaiting approve/reject/amend. That decision has now been made and fully
actioned. All commits pushed to `main` (`b536d76`), **CI green** (`gh run
30200944290`, 17m12s: `shared`/`mobile`/`mobile-android`/`gate` all success, advisory
`apk` also success — no `desktop` job, as expected).

## Shipped this session

- `b536d76` **`chore: deprecate and remove apps/desktop`** — user approved Option A
  (deprecate) from the decision doc. Implemented in full:
  - Deleted `apps/desktop/` entirely (Tauri v2 stub — placeholder page, zero tests, zero
    commits since 2026-06-04).
  - Dropped the `desktop` job from `.github/workflows/ci.yml` and removed it from
    `gate.needs` (now `[shared, mobile, mobile-android]`).
  - Updated `CLAUDE.md` (workspace list, commands table, CI section, hard-constraints
    section, structural-notes section), `README.md` (layout diagram + removed the
    "Desktop app" section), `docs/CONTRIBUTING.md` (prerequisites, scripts table, running-
    locally, CI section), `docs/smoke-test.md` (dropped the stale Tauri/navetted-token
    checklist section), and `docs/CODEMAPS/{architecture,backend,dependencies}.md` (each
    left a one-line pointer to the plan doc instead of describing dead code).
  - `TODO.md`'s "Desktop app fate" item checked off with the decision and rationale.
  - Root `package.json`: removed `desktop`/`desktop:tauri` scripts; `npm install` run to
    regenerate `package-lock.json` cleanly (12 packages removed, no new vulnerabilities
    introduced beyond pre-existing audit noise).
  - Plan doc moved to `.claude/PRPs/plans/completed/desktop-fate.plan.md`, status updated
    to "approved 2026-07-25 — Option A implemented."
  - Verified before push: `tsc --noEmit` clean on both `mobile` and `shared`, lint clean,
    all **1117 tests passing** (no count change — desktop had zero tests to lose).
  - Historical PRP docs (`AUDIT-backend.md`, `backlog-audit-2026-06-13.md`,
    `carnet-deferred-and-polish.plan.md`, `desktop-secure-token.plan.md`,
    `stage2-backend-and-capture.plan.md`, the rename-app-package plan, `pr-2-review.md`,
    `.agent_native/agent_roadmap.md`) were deliberately **left untouched** — they're
    dated, append-only records of past state, not living documentation, so stale
    `apps/desktop` references in them are historically accurate and not bugs.

## Process notes (unchanged, still in force)

- Devils-advocate + CI-gate loop stayed in force for this change even though it was
  mechanical (deletion + doc updates) — full local verification (typecheck/lint/tests) ran
  before push, and CI was checked post-push rather than assumed green.
- CI required-check surface is now **three** parallel jobs after `shared`
  (`mobile`, `mobile-android`) instead of four — `gate` no longer waits on desktop's
  ~45s "stub still compiles" check.

## Open / user-side

- Everything else from the 2026-07-23 handoff's open-items list is still open and
  unchanged by this session: Karakeep test bookmarks awaiting manual delete, local-LLM
  Settings UI worth an explicit on-device confirmation pass, OmniRoute Mistral key
  deletion, self-hosted Sentry backlog.
- `.claude/scheduled_tasks.lock` has shown as a modified-but-uncommitted file across the
  last several sessions (git status noise, not part of any of these commits) — worth
  checking once whether that's expected scheduler bookkeeping that should be committed or
  gitignored, since it's been silently carried for at least three session boundaries now.
- No new forks or decisions opened this session — this was a clean close-out of the one
  item flagged as most actionable last time.
