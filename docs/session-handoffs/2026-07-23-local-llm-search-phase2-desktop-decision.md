# Session handoff — 2026-07-23 (local-LLM backend shipped; Search Phase 2 shipped; desktop deprecation decision awaiting CONFIRM)

## State at handoff

Continuation of `2026-07-18-lint-gate-linkplus-live-banner.md` (that one covers
the ESLint gate, link-plus, and live banner arc — still current, no
regressions since). All commits below are pushed to `main`, **every CI run
green** (`gh run list` confirms). Suite: **1117 tests** passing (`73` test
files), lint clean. The devils-advocate + CI-gate mandate from the prior
handoff stayed in force for every change in this arc.

## Shipped since 2026-07-18

- `b230040` **SAF folder-duplication race fix** — `findOrCreateSubdir` did a
  check-then-create as two separate async round-trips; SAF's
  `makeDirectoryAsync` auto-renames on collision instead of failing, so two
  concurrent callers for the same not-yet-existing folder (e.g. a queue flush
  racing a screen refresh) could both pass the missing-check and both create,
  silently splitting the vault into `Journal` + `Journal (1)` — **confirmed
  on-device**. Fixed by deduping concurrent creates for the same
  `(parentUri, name)` onto one in-flight promise.
- `7c37239` **Search Phase 2 (#104)** — on-demand full-text body search,
  closing the largest deferred v0.3 search item flagged in the 2026-07-18
  handoff. Design doc `298a725` + TDD task breakdown `32672dc` preceded
  implementation. `SearchScreen` now supports body-content search, not just
  title/frontmatter.
- `6b923d2` **Local-LLM backend (#105)** — disconnected/no-internet
  enrichment path, closing the Relais open item from the last handoff. Design
  doc `dd58b83` + TDD breakdown `dc0f184` preceded implementation. Key
  pieces:
  - New `LlmBackend` variant `"local"`; `localLlmUrl`/`localLlmModel`
    (AsyncStorage) + `localLlmApiKey` (SecureStore-only) added to
    Settings/PersistedSettings, mirroring the existing OmniRoute/Karakeep key
    pattern.
  - New loopback OpenAI-compatible client module for the local backend.
  - Dispatcher error-predicate classification refactored onto a shared
    `HttpError` base (`1906` in memory — landed as part of this arc).
  - `composeSettingsForSave`/`currentKeysOrEmpty` threaded through so saving
    Settings doesn't silently wipe local-LLM config before its own UI
    landed.
  - `6b6d27c` **follow-up fix**: CaptureScreen's "submitting" phase label
    always said "OmniRoute is structuring the note…" regardless of the
    configured backend — caught via an on-device Wi-Fi-off isolation test
    (routing was correct, only the label lied). Now reads `llmBackend` off
    the existing mount-time `getSettings()` call.
  - **Corrects a prior-memory claim**: `project_relais_enrichment_outages`
    said the 2026-07-17 Relais/OmniRoute correlation was coincidence and
    Relais was "the target for a planned standalone local-LLM backend" — that
    plan is now built and shipped, not just planned.
- `1cfb27f` **Desktop app fate — deprecation decision doc**
  (`.claude/PRPs/plans/desktop-fate.plan.md`), **proposed, awaiting CONFIRM,
  not yet actioned**. Corrects a stale claim repeated across six prior
  handoffs ("dogfooding has happened") — verified today that `apps/desktop`
  has had **zero commits since 2026-06-04**, is an 11-line placeholder page,
  has zero tests, and whatever pre-v0.2 dogfooding happened was of the
  `navetted` WebSocket daemon implementation that was deliberately ripped out
  and no longer exists in any form. Recommends **Option A: deprecate** (hard
  delete `apps/desktop/`, drop the `desktop` CI job from `gate.needs`, update
  `CLAUDE.md`/root `package.json`) over Option B (2-4 week rebuild against
  OmniRoute, no demand signal) or Option C (status quo — what's been
  happening for six handoffs). **TODO.md still lists this as an open,
  undecided checkbox — the doc has not been approved/rejected/amended yet.**

## Process notes (unchanged, still in force)

- Devils-advocate + CI-gate loop is mandated for every change; CI runs
  ~17-21 min, `gate` (shared/mobile/desktop/mobile-android) is the required
  check, `apk` is advisory.
- ESLint (3 rules, mobile-only) runs in the `mobile` CI job; scope is
  change-controlled per `minimal-eslint-scope.plan.md` — do not widen it
  without the same process this doc uses.

## Open / user-side

- **Desktop fate decision** (`.claude/PRPs/plans/desktop-fate.plan.md`) is
  the single most actionable open item — it's a fully-scoped
  approve/reject/amend ask, not open-ended research. Recommend reading it
  fresh (superseded the "dogfooding happened" framing from every prior
  handoff) and giving a decision so it stops resurfacing.
- Local-LLM backend: Task 6 (SettingsScreen UI for local-LLM fields) — verify
  it actually landed with full UI, not just the schema/plumbing described in
  the first commit message; the follow-up `6b6d27c` fix implies the backend
  is user-selectable and working, but worth an explicit on-device pass
  selecting Local + confirming enrichment end-to-end with Wi-Fi off.
  Auto-memory `project_local_llm_verified_e2e` (2026-07-23 7:43a) suggests
  this was already done — confirm before re-testing.
- Karakeep test bookmarks awaiting manual delete (carried over, still
  unresolved — see 2026-07-16 handoff for the list).
- Backlog, still untouched: OmniRoute Mistral key deletion, self-hosted
  Sentry.
- `.claude/scheduled_tasks.lock` shows as modified in working tree at time of
  writing — check whether that's expected scheduler bookkeeping or a stray
  uncommitted change before the next session starts.
