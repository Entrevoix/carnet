# Proposal: self-hosted crash/error reporting (decision doc)

Status: **approved 2026-07-26 — Option B implemented.** Global JS-error handler
(`lib/crashReporting.ts`) + local ring-buffer crash log (`lib/crashLog.ts`, AsyncStorage,
capped at 20) + a render-phase `CrashBoundary` component + a Settings → Diagnostics
section (`components/DiagnosticsSection.tsx`) to view/copy/clear the log. No server, no
new infrastructure — matches this project's "no server, no database" architecture.
Date: 2026-07-26
Origin: "Self-hosted Sentry crash reporting" first appears in the 2026-07-09 handoff's
"Not started (mentioned, not yet worked on)" list, with zero scoping beyond that one
line. It has been carried, unscoped, across at least seven subsequent session handoffs
(2026-07-11, -12 ×2, -17, -18, -23, -26) without ever becoming an actionable task. This
doc gives it the same treatment `desktop-fate.plan.md` gave the desktop item: a concrete,
evidence-based recommendation so the next touch is approve/reject/amend, not another
"still on the backlog" line.

## What problem this would actually solve

There is **no crash/error telemetry in the app today** — confirmed: no `Sentry`,
`Bugsnag`, or `crashlytics` reference anywhere in `apps/mobile`, no crash-reporting
dependency in `package.json`. Every real on-device defect in this project's history was
found by **manual reproduction + `adb logcat`**, not by an automated report surfacing it:

- The STT "code-9" bug (auto-memory `project_stt_code9_root_cause`) — found by manually
  triggering it and reading logcat, not from a crash report.
- The `expo-share-intent` crash loop ("Carnet keeps stopping") that led to the
  `expo-share-intent+5.1.1.patch` in `patches/` — same pattern: reproduced on-device,
  root-caused via logcat, patched.
- The SAF folder-duplication race (`b230040`, 2026-07-19) — found by manual vault
  inspection after the fact, not flagged automatically.

This is a real gap, not a hypothetical one: every crash so far has depended on someone
noticing the app stopped, then manually reproducing it with a cable attached. That works
for a single-developer dogfooding phase but doesn't scale to any other user, and doesn't
catch crashes that don't reproduce on the first try.

## Options

### Option A — Self-hosted Sentry (the originally-proposed idea)

Stand up a self-hosted Sentry instance (Docker Compose, on the same workstation already
running OmniRoute at `192.168.1.20`) and wire `@sentry/react-native` into `apps/mobile`.
- Cost: real infra to provision and maintain — Sentry's self-hosted stack is multi-container
  (Kafka, ClickHouse, Postgres, Redis, Relay, web/worker processes) and is one of the
  heavier self-hosted options available for this purpose; it's a meaningfully bigger
  operational surface than OmniRoute (a single container).
  Client-side: `@sentry/react-native`'s Expo config plugin needs a native rebuild (already
  routine here — `expo prebuild` + `mobile-android` CI job would need to compile it, same
  category of risk this project already tracks for `expo-speech-recognition`/
  `expo-share-intent`).
- Benefit: full crash grouping/dedup, source-map symbolication, release tracking,
  breadcrumbs, session-replay-adjacent tooling if ever wanted. Mature, well-documented
  product; matches the "self-hosted, no third-party data leaves the LAN" requirement this
  project has already applied to OmniRoute and Karakeep.

### Option B — Lightweight local crash log, no server (recommended)

Add a minimal on-device crash/error log: wrap the app's root error boundary +
`ErrorUtils.setGlobalHandler` (React Native's global JS-exception hook) to append
structured crash records (timestamp, stack, last-known screen/action) to a small
AsyncStorage-backed ring buffer or a plain file in the vault folder (e.g.
`.carnet-diagnostics/crash-<timestamp>.json`), viewable from a hidden/debug Settings
screen or just pulled via `adb pull` / Syncthing like everything else in the vault.
- Cost: small, in-repo, no new infrastructure. Follows this project's own pattern —
  `lib/*.ts` module + tests, no server, no database, consistent with the hard constraints
  in `CLAUDE.md`.
- Trade-off vs. Option A: no remote alerting (you have to go look), no automatic
  dedup/grouping across users (there's currently exactly one user, so this doesn't cost
  much today), no source-map symbolication (stack traces are Hermes-minified in release
  builds — would need `sentry-cli`-equivalent tooling or accept unminified debug traces
  during triage). For a single-developer dogfooding project this covers the actual
  observed gap (nothing captures crashes automatically) without taking on Sentry's
  multi-container operational weight.
- **Known limitation (surfaced in devils-advocate review, implementation): fatal crashes
  are the least reliably persisted.** `recordCrash`'s AsyncStorage write is async and
  isn't (can't be) awaited before RN's default handler tears the process down for a fatal
  exception — there's no guarantee the write flushes first. Non-fatal crashes (caught by
  `CrashBoundary`, or a non-fatal global-handler error) persist reliably; this is a
  best-effort log for the fatal case, not a synchronous crash logger. A synchronous store
  (e.g. MMKV) would close this gap but is out of scope — the project's no-SQLite
  constraint doesn't rule out MMKV specifically, but swapping storage engines for one edge
  case wasn't judged worth it here.

### Option C — Status quo (do nothing)

Keep relying on manual reproduction + logcat, as has worked so far. Costs: the item keeps
resurfacing in every handoff (as it has for seven sessions running) without ever being
either done or explicitly rejected; crashes that don't reproduce easily continue to be
invisible until someone happens to notice the app stopped.

## Recommendation

**Option B — lightweight local crash log.** The actual problem (zero automatic crash
capture) is real and worth fixing, but Option A's operational cost (a 6+ container
self-hosted stack) is disproportionate to a single-developer dogfooding project's actual
need. Option B closes the real gap — something records what happened when the app dies,
instead of relying on someone noticing and reattaching a cable — while staying inside this
project's established "no server, no database, plain files" architecture. If Carnet ever
gets a second real user or the manual-triage cost of Option B becomes a genuine time sink,
revisiting Option A then is a fresh, evidence-backed decision — not a resurrection of a
sunk-cost mention from the backlog.

## Open decisions

- **Where the crash log lives**: inside the app sandbox (AsyncStorage ring buffer, capped
  at N entries) vs. a file under the Syncthing-watched vault folder (auto-replicates to
  the workstation, but pollutes the Obsidian vault with non-note files unless placed in a
  dotfile-style subfolder Obsidian ignores). Recommend the vault-adjacent dotfile approach
  if `captureFolderPath`'s parent is writable, falling back to AsyncStorage otherwise —
  needs a concrete look at what's actually writable from SAF before committing.
- **Retention**: cap count (e.g. last 20 crashes) or age (e.g. 30 days) — either is fine,
  pick one during implementation.
- **Symbolication**: release builds use Hermes bytecode; if a crash trace is unreadable in
  practice, this may need `expo-updates`' sourcemap output wired in later — not blocking
  for a first cut.

## Decision requested

- **Approve** → one PR implementing Option B (global error handler + crash-log module +
  tests + a way to view/export the log), through the devils-advocate + CI-gate loop as
  usual.
- **Amend** → pick Option A instead (accept the heavier infra cost) or adjust Option B's
  storage location.
- **Reject** → status quo stays; this doc moves to `plans/completed/` with a "rejected,
  keeping manual triage" status so the item stops resurfacing in every handoff.
