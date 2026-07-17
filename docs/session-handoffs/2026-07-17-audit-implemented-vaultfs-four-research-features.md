# Session handoff — 2026-07-17 (full audit implemented incl. VaultFs; all four research features shipped; devils-advocate+CI gate mandated)

## State at handoff

Continuation of `2026-07-16-pending-sync-queue-built-share-contenturi-fix.md`. Thirteen
commits pushed to `main` since; every completed CI run green (three newest runs were
in-flight at handoff — check `gh run list`). Device runs the current tree
(release install `2026-07-17 13:45:12`). Suite: **1073 tests**, tsc clean, no lint
(still deliberate).

## Process mandate (STANDING — see auto-memory `devils-advocate-ci-gates-loop`)

Mid-session the user mandated: every change goes through a **/devils-advocate review
loop before commit**, and **CI must be green before starting the next item**. The first
two loops each caught real issues (below). Follow this for all future work.

## 1. The 2026-07-16 three-way audit is now FULLY implemented

- `aa2b464` fix-now set — sanitize non-LLM share stubs (security HIGH: degraded share
  paths wrote attacker-controlled content into the Dataview/Templater-executing vault
  unsanitized), Settings save guard, patch `mapOf` correctness, queue-scaffolding
  dedupe (`lib/asyncQueueUtils.ts`).
- `1e769df` error-surfacing batch — five silent-failure sites + the first
  ShareReceiveScreen smoke test (incl. a security regression test: hostile share text
  must reach `writeIdea` sanitized — enrichSanitize imported REAL).
- `35e701e` `lib/httpClient.ts` — the shared HTTP-client security surface
  (HttpError base, THE canonical Bearer redactor, withTimeout, unified parseErrorBody).
- `9c12b4c` dispatcher seam completed — transcribe/autoTranscribe/ocrCardViaVision/
  listModels now cross B7; screens import from dispatcher only.
- `6c81162` + `77c56d5` `writerSaf.test.ts` — SAF parity suite (28 tests; in-memory
  harness modeling full-URI listings + create-time renames; hardened per review with a
  full mime→ext rename table and the mtime-guard-inert-over-SAF pin).
- `7f17830` **VaultFs seam** — `lib/vaultFs.ts` (SafFs/FileFs selected once in
  resolveRoot/fsForUri); writer.ts 1250→~1000 ln, ~40 isSaf branch points → 0; both
  writer suites passed UNCHANGED. Executed by a fresh-context agent, independently
  verified at the sensitive spots (9171376 finalName contract, c896d9d decoded archive
  names, delete semantics, inert SAF mtime guard).

## 2. All four market-research recommendations shipped (research report: this session)

- `1fe2f13` **sync-conflict visibility** — the fix half matters most: Syncthing
  `*.sync-conflict-*` copies were being INDEXED AS NOTES (Search/tag pollution).
  `listNoteFiles` filters them; `lib/syncConflicts.ts` (pure regex/pairing) +
  `listSyncConflictFiles` + Home banner → review dialog (Open copy / Open original →
  RecentDetail; archive-delete resolves). No merge UI by design.
- `ca47be8` **action-item extraction** — idea/journal prompts emit `## Actions` as
  `- [ ]` checkboxes, faithful-only ("NEVER invent tasks"), section OMITTED when none
  (was a free-text "None" placeholder); person Follow-up → checkboxes. First
  `prompts.test.ts` (structural invariants: delimiters, injection guard, skeletons).
  **Live-capture VERIFIED on-device (both directions)**: commitments capture produced
  a faithful two-checkbox `## Actions` section verbatim; the no-commitments control
  enriched with NO Actions section and no placeholder. During testing OmniRoute
  briefly went unreachable — the save-first fallback + pending banner behaved exactly
  as built — possibly correlated with the device's local LLM host app ("Relais",
  com.ventouxlabs.relais.izzy) foregrounding itself; user to confirm whether
  OmniRoute routes through it. One orphaned enrichment-queue row may exist from a
  note deleted while pending — self-limiting (drains to failed), ignorable.
- `bf132fd` **related-notes card** (RecentDetail) — `lib/relatedNotes.ts`, pure lexical
  scoring over the cached index (tags 3 > title terms 2 > excerpt 1; zero-score = no
  card; top 3). Devils-advocate loop caught: self-exclusion had to be made robust to
  SAF write-path vs listing-path URIs disagreeing on percent-encoding (else the open
  note becomes its own top hit) — decoded-basename+subdir fallback, tested. Also fixed
  retro: conflict dialog now resolves BEFORE closing (vanished note keeps the dialog
  up); idea/journal skeletons got explicit `{ONLY when …:}` conditional markers on the
  Actions block.
- `711102b` **cold-start budget tripwire** — `lib/startupTiming.ts`:
  `BOOT_TIMESTAMP_MS` at first app-code import, Home's first mount reports; breach
  (>3000ms) → console.warn (survives release stripping); within-budget → dev-only
  metric line. smoke-test.md gained the "no [startup] EXCEEDS in logcat" check —
  **verified passing on-device on the fresh install**. Budget is a conservative
  ceiling pending a measured dev-build baseline — read the dev metric line sometime
  and tighten. NB: this commit's message says "1077/1077"; the true count is 1073 —
  message overstates, don't trust it over `npm test`.

## Codemaps / docs

Refreshed in this session's final docs commit: backend.md (httpClient, VaultFs,
dispatcher-complete, syncConflicts/relatedNotes/startupTiming), architecture.md
(53 lib modules), frontend.md (screen rows). RUNBOOK/smoke-test were synced earlier
(pending-sync + allowlist rows; cold-start check).

## Open / next

- **Live-capture check** for action-item extraction (above) — the one thing prompts
  tests can't prove.
- Stale Home banner count after a background pending-sync drain (cosmetic, known fix
  shape: re-read count on an AppState listener).
- Watch item: stop-tap during Soda's `blockingReconnect` window (lingering mic pill).
- Karakeep test bookmarks still awaiting the user's manual delete (list in the
  2026-07-16 handoff).
- Backlog unchanged: OmniRoute Mistral key deletion, self-hosted Sentry, minimal
  ESLint scope discussion, desktop fate. Related-notes could later gain the
  `[[link]]`-insert half; resurfacing ("on this day") was deliberately skipped as
  low-evidence.
