# Session handoff — 2026-07-18 (ESLint gate live; link-plus shipped; live banner; cold-start calibrated)

## State at handoff

Continuation of `2026-07-17-audit-implemented-vaultfs-four-research-features.md`
(read that one for the audit/VaultFs/four-features arc and the STANDING
devils-advocate + CI-gate mandate — auto-memory `devils-advocate-ci-gates-loop`).
All commits pushed; **every CI run green including advisory `apk`**. Device runs
`main`'s head (release install `2026-07-18 20:57:56`). Suite: **1084 tests**,
`tsc` clean, **lint clean**.

## Shipped today (each through the devils-advocate loop + CI gate)

- `3db732d` cold-start calibration datum: `am start -W` 470-545ms (3× launches,
  release) recorded in `lib/startupTiming.ts` explicitly as ACTIVITY-DRAWN time
  (lower bound on the JS span); 3000ms budget stands as a several-× tripwire.
- `3c65a37` **live pending-Karakeep banner** — `subscribePendingSyncChanges` in
  `lib/pendingSync.ts` (bare change ping after each locked mutation; read path
  stays source of truth); Home re-reads the count on ping. Closed the last known
  cosmetic defect (stale banner during a background drain).
- `76d59fe` → approved → **ESLint implemented and IN THE REQUIRED GATE**
  (`ci(lint)` commit): exactly 3 rules — `react-hooks/rules-of-hooks` (error),
  `exhaustive-deps` (warn), typed `no-floating-promises` (error, ignoreVoid) —
  mobile workspace only, flat config `apps/mobile/eslint.config.mjs` with a
  structural `ignores` fence and `reportUnusedDisableDirectives: "off"` (both
  earned: `--fix` once stripped a GENERATED file's blanket disable and
  intent-documenting test annotations — reverted; don't re-run blanket `--fix`).
  First run found **9 real errors** incl. an omniroute `.finally` re-rejection
  bug and unswept `voice/` sites. `openSyncDetail` moved above the Home header
  effect (naive dep-add was a TDZ crash). VoiceButton's mount-once recognizer
  effect is ANNOTATED, never re-depped (restart-race minefield). Scope widening
  is change-controlled: `.claude/PRPs/plans/completed/minimal-eslint-scope.plan.md`;
  CLAUDE.md + CONTRIBUTING updated.
- link-plus (`feat(notes)` commit): **[[wikilink]] insert from the Related
  card** — `insertRelatedLink` (pure, in `lib/relatedNotes.ts`, deliberately
  self-contained: `upsertSection` REPLACES sections wholesale, wrong primitive,
  and importing writer dragged its module graph into a pure module — its
  identity-stub in the screen test's writer mock silently ate the insert, which
  is how this was caught). Appends `- [[Title]]` under `## Related`
  (created-at-end when absent); dedupe covers exact AND aliased
  (`[[Title|display]]`) forms; titles sanitized for `[ ] | # ^` + newlines.
  Screen: in-flight guard, Save-failed banner on write failure, "Already
  linked" snackbar. This effectively closes TODO's deferred "cross-capture
  linking" item.

## Process notes for the next session

- The devils-advocate + CI-gate loop is MANDATED for every change. CI runs take
  ~17-21 min; the `gate` job (shared/mobile/desktop/mobile-android) is the
  required check — `apk` is advisory.
- Lint runs in the `mobile` CI job. `npm -w @carnet/mobile run lint`.
- A config-protection hook blocks Write-tool edits to eslint config; the initial
  creation went via shell with the user's explicit approval on record.

## On-device verification pending (small)

- Tap link-plus on a Related row → note gains `## Related` + `[[wikilink]]`
  (Obsidian graph picks it up post-Syncthing); second tap → "Already linked".
- Live banner: export with VPN off → banner; VPN on + foreground → banner
  clears WITHOUT leaving/refocusing Home.

## Open / user-side

- Relais (`com.ventouxlabs.relais.izzy`, local LLM host on the Pixel): likely in
  the OmniRoute path — foregrounded itself during the 2026-07-17 enrichment
  outage (auto-memory `relais-local-llm-enrichment-outages`). User to confirm.
- Karakeep test bookmarks awaiting manual delete (list in 2026-07-16 handoff).
- Big forks awaiting a user pick: **Search Phase 2/3** (full-text + retrospective
  query — largest deferred v0.3 item) or **desktop fate** (dogfooding has
  happened; decision doc would mirror the ESLint-proposal pattern).
- Backlog: OmniRoute Mistral key deletion, self-hosted Sentry.
- Cold-start budget: read a dev-build `[startup]` metric line someday to
  calibrate the JS span properly, then consider tightening 3000ms.
