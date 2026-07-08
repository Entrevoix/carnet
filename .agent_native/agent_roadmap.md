# Carnet — Agent-Native Roadmap

Audit date: 2026-07-07. Goal: let an AI coding agent take a raw bug report or feature
request and autonomously reproduce, implement, test, and verify it with minimal human
input. This repo already does a lot right (see "What's already agent-native" below) — this
roadmap targets the remaining gaps.

Ranked by **Human-Attention-Saved per Unit of Effort** (HAS/E) — highest leverage first.

**Status (2026-07-07, agent pass):** Items 1, 3, and 4 done — see notes inline below.
Item 2 (screen-file decomposition) and item 5 (plan-lifecycle status markers) are
untouched: item 2 is a large multi-file refactor out of scope for a quick pass; item 5
requires a human judgment call on each existing plan's actual shipped/draft state before
adding status markers, so it's left for a human or a dedicated follow-up session.

---

## Top 5 — immediately actionable

### 1. Add a `.env`-free fixture/replay harness for `writer.ts` + `omniroute.ts` bug reports — DONE (2026-07-07)
Implemented: `apps/mobile/test/fixtures/vault/` (idea-simple, idea-unicode-title,
journal-entry-1/2, person-card) and `apps/mobile/test/fixtures/omniroute/`
(idea-wellformed, idea-malformed-frontmatter, idea-oversized JSON). Repro harness is
`apps/mobile/test/fixtures/repro.test.ts` (vitest, not a standalone script — reuses the
writer.test.ts in-memory expo-file-system mock). Reproduces all 4 named bug classes:
unicode slugs, filename collision, same-day journal append, mtime conflict guard,
plus the OmniRoute response-validation gate. `vitest.config.ts`'s `include` was widened
to also match `test/fixtures/**/*.test.ts` (previously `src/**/*.test.ts` only).
Verified: `npm -w @carnet/mobile exec vitest run test/fixtures/repro.test.ts` → 10/10
passing; full `npm -w @carnet/mobile test` → 739/739 passing; `tsc --noEmit` clean.

**HAS/E: very high.** The #1 recurring cost in this repo's own session-handoff docs is
re-deriving repro steps for frontmatter/markdown bugs by hand each time. There is no
`fixtures/` directory anywhere in the repo (confirmed: no `*fixture*` or `*.sample.md`
files exist outside inline test strings).

- **Files:** create `apps/mobile/test/fixtures/` with: 3–5 real-shaped vault notes (Idea,
  Journal multi-entry, Person) covering the tricky cases already called out in `TODO.md`
  and `writer.ts` (unicode slugs, filename collision, same-day journal append, mtime
  conflict guard) and 2–3 canned OmniRoute JSON responses (well-formed, malformed
  frontmatter, oversized).
- **Command:** wire a `apps/mobile/scripts/repro.ts` (run via `node --loader tsx` or a
  vitest test named `repro.test.ts`) that takes a fixture name and runs it through
  `writer.ts` / `enrichSanitize.ts`, printing the resulting file content — so an agent
  given "user says journal append duplicated the timestamp" can reproduce it in one
  command instead of spinning up Expo.
- **Acceptance:** `npm -w @carnet/mobile exec vitest run test/fixtures/repro.test.ts`
  reproduces at least the 4 historical bug classes named above from a fixture, no device
  needed.

### 2. Split the four largest screen files into UI + extracted `lib/` logic
**HAS/E: high.** `CaptureScreen.tsx` (1039 lines), `RecentDetailScreen.tsx` (1458 lines),
`SettingsScreen.tsx` (934 lines) all blow past this project's own 800-line/50-line-function
style rules and mix business logic (save flow, conflict detection, export triggering)
directly into React components with zero test coverage (0 of 12 files under
`apps/mobile/src/screens/` have a `.test.tsx`). An agent asked to fix a save-flow bug today
has to read 1000+ lines of JSX to find the 30 lines of logic that matter, and cannot write
a unit test against it without a full RN render harness.

- **Files:** `apps/mobile/src/screens/CaptureScreen.tsx`,
  `apps/mobile/src/screens/RecentDetailScreen.tsx`,
  `apps/mobile/src/screens/SettingsScreen.tsx`.
- **Action:** extract non-UI logic (save-first mtime-conflict handling, Karakeep
  re-export confirm logic, settings validation) into new `lib/*.ts` modules following the
  existing pattern (`lib/ideaSaveFirst.ts`, `lib/journalTagIndex.ts` already do this well —
  extend the pattern to the screens that still inline it).
  Recent screens are the outlier; the `lib/` layer is otherwise well-factored (~50 focused
  modules, each with a co-located `.test.ts`).
- **Acceptance:** each extracted module gets a co-located `.test.ts` at the same density as
  existing `lib/` files (roughly 1 test file per module); the screen file drops under 800
  lines or has an explicit CLAUDE.md-documented exception.

### 3. Add a scriptable "read-only" doctor check that mirrors `docs/smoke-test.md` — DONE (2026-07-07)
Implemented: `apps/mobile/package.json` script `verify:capture-flow` runs
`writer.test.ts frontmatter.test.ts queue.test.ts vault.test.ts vaultSearch.test.ts
journalTagIndex.test.ts markdownRoundTrip.test.ts test/fixtures/repro.test.ts`.
`docs/smoke-test.md` now has an "Automated coverage" callout near the top plus
per-section `(automated coverage: ...)` annotations on Idea/Promote/Journal/Offline
queue/Rich edit/Unicode-collision sections. `docs/CONTRIBUTING.md`'s scripts table
updated with the new command. Verified: `npm -w @carnet/mobile run verify:capture-flow`
→ 245/245 passing.

**HAS/E: high.** `docs/smoke-test.md` is a well-written checklist but is 100% manual —
there's no way for an agent to self-verify a capture-flow change without a physical Android
device, Syncthing, and a human ticking boxes. Most of the checklist's *logic* (frontmatter
shape, slug collision, byte-identical status promotion, queue drain) is already covered by
existing `lib/*.test.ts` files — the gap is a single command that runs exactly the subset of
vitest suites the smoke test exercises, so an agent can say "I re-ran the automated
equivalent of smoke-test steps 1–6" with evidence.
- **Files:** add `apps/mobile/package.json` script `"verify:capture-flow"` that runs
  `vitest run src/lib/writer.test.ts src/lib/queue.test.ts src/lib/frontmatter.test.ts
  src/lib/vault.test.ts` (adjust to actual filenames covering promote/collision/append) and
  reference it from `docs/smoke-test.md` under each relevant section ("automated coverage:
  `npm run verify:capture-flow`").
- **Acceptance:** running the script exits 0 and its output is quoted in
  `docs/smoke-test.md` as the "what CI-equivalent already checks" column.

### 4. Promote `mobile-android` CI job into the required `gate`, or document why not — DONE (already satisfied)
Verified 2026-07-07: `CLAUDE.md` already states plainly there is no lint gate, desktop
has no real tests, and `mobile-android` is advisory-only (cross-checked against the
actual `.github/workflows/ci.yml` job comments — they match). No further action needed;
this item was already closed by the CLAUDE.md this audit produced.
**HAS/E: medium-high, low effort.** The CI file (`.github/workflows/ci.yml`) has a detailed
comment explaining `mobile-android` (Kotlin compile smoke test) is deliberately excluded
from `gate.needs` because it "has never been observed green." This is exactly the kind of
tribal knowledge that should live in CLAUDE.md so an agent doesn't waste a cycle trying to
add it to the gate, or conversely doesn't skip fixing it when it's actually broken. Also:
CI has **no lint step at all** (confirmed — `CONTRIBING.md` explicitly says "no lint
script") and `apps/desktop` tests run with `--passWithNoTests` (zero real desktop tests
exist today) — an agent could be misled into thinking desktop is tested.
- **Files:** `.github/workflows/ci.yml`, new `CLAUDE.md` (done — see below).
- **Action:** no code change needed beyond documentation; captured in the CLAUDE.md this
  audit produces. If/when `mobile-android` goes green three times, promote it per the
  comment's own instructions.
- **Acceptance:** CLAUDE.md states plainly "there is no lint gate," "desktop has no real
  tests yet," and "`mobile-android` is advisory only" so agents don't assume more coverage
  than exists.

### 5. Make the `.claude/PRPs/plans` → `reports` → `reviews` lifecycle machine-checkable
**HAS/E: medium.** This repo has an unusually good existing agent workflow: PRDs → plans →
execution reports → reviews, with completed plans moved to `plans/completed/`. But nothing
enforces the move — the `backlog-audit-2026-06-13.md` finding was literally "three plans
describe already-shipped work because nobody moved them to completed/", costing a human a
full audit cycle to discover. A cheap script check (e.g., grep each `plans/*.md` for a
"Status: shipped" marker crossed against merged PRs, or just a periodic `find
.claude/PRPs/plans -newer <merge-marker>`) would let an agent self-detect stale plans instead
of a human re-deriving state each session.
- **Files:** `.claude/PRPs/plans/*.md` (add a required `Status: draft|in-progress|shipped`
  frontmatter-style header line if not already present), optionally a tiny
  `scripts/check-stale-plans.sh`.
- **Acceptance:** an agent starting a new session can run one command and get "these plans
  are marked shipped but still in plans/ — move to completed/" instead of manually cross-
  referencing git log.

---

## What's already agent-native (don't rebuild this)

- **`.claude/PRPs/{plans,reports,reviews,prds}/`** — a real plan→execute→review pipeline
  with dated session-handoff docs (`docs/session-handoffs/`) that already capture open
  questions, resolved decisions, and non-negotiable constraints for continuation across
  sessions.
- **`docs/CODEMAPS/`** — token-budgeted architecture/backend/frontend/data/dependency maps,
  clearly designed for agent context loading.
- **`DESIGN.md`** has an explicit "For AI tooling" section with hard rules (no second accent
  color, no gradients, token-only colors) — a strong pattern; CLAUDE.md below cross-links it
  rather than duplicating it.
- **`CONTRIBUTING.md`** has an `<!-- AUTO-GENERATED:scripts -->` block — already built to
  stay in sync with `package.json`; verified against actual `package.json` scripts during
  this audit and found accurate.
- **~600 vitest tests** across `packages/shared` and `apps/mobile/src/lib/**` with
  deliberate stub modules for RN-native packages that Rollup can't parse
  (`apps/mobile/test/__stubs__/`) — a genuinely good pattern for testing native-adjacent
  logic without a device.

## Audit findings by area (detail)

### 1. Human-judgment chokepoints
- **Device-gated verification is unavoidable but under-flagged.** Real Android builds
  (release APK install, STT model download + speak-test, share-sheet real gesture, OCR
  quality on a real business card) cannot be done headlessly — confirmed in
  `docs/session-handoffs/2026-07-04-stage2-b3-b0.md` ("B2 remains gated... do not start
  until the user runs the on-device VLM-vs-dedicated-endpoint comparison") and the
  `mobile-android` CI job comment. This is correctly identified in existing docs already;
  the fix is just making sure CLAUDE.md states the boundary explicitly so a fresh agent
  doesn't attempt device work or falsely claim it's done.
- **"Fix the implementation, not the test"** is stated in `CONTRIBUTING.md` but not in a
  file an agent is guaranteed to load; migrated into CLAUDE.md.
- **Conventional commit types + squash-merge convention + attribution-disabled** are tribal
  knowledge scattered across `CONTRIBUTING.md` and the user's global git-workflow rules;
  consolidated in CLAUDE.md.

### 2. Verification gaps
- **Zero screen-level UI tests** (0/12 files in `apps/mobile/src/screens/`). All ~600 tests
  are in `lib/`, `bridges/`, `voice/`. This is a real gap for UI regressions, but note issue
  #2 above (extract logic first) is more valuable than bolting RN Testing Library onto
  1400-line screens as-is.
  - Note: `apps/desktop` currently has **zero real tests** (`test` script uses
  `--passWithNoTests`), so its CI green check is not meaningful evidence of correctness.
- **No lint gate anywhere** — confirmed no `eslint`/`biome` config or script in any
  `package.json`. `tsc --noEmit` + vitest are the only automated gates.
- **`mobile-android` CI job is advisory, not required** (explicit in the workflow's own
  comments) — an agent should not assume a green `gate` means Android native code compiles.

### 3. Reproduction paths
- **No fixtures directory** exists anywhere in the repo (checked `*fixture*`, `*.sample.md`
  — none found). Bug reproduction currently means writing an ad hoc test each time, which is
  exactly the kind of one-shot busywork a small fixtures library removes (item #1 above).
- **`docs/smoke-test.md` is human-only** — a good checklist, zero automation hooks. Item #3
  above bridges it partway without needing a real device.

### 4. Structural obstacles
- **Screen files carry business logic inline**, in violation of this repo's own coding-style
  rules (800-line file / 50-line function caps from the user's global CLAUDE.md rules):
  `RecentDetailScreen.tsx` (1458 lines), `CaptureScreen.tsx` (1039), `SettingsScreen.tsx`
  (934), plus `writer.ts` (1148) and `omniroute.ts` (710) in the lib layer itself already
  near/over the cap. The `lib/` layer's smaller, single-purpose modules (e.g.
  `netAllowlist.ts`, `frontmatter.ts`, `ideaSaveFirst.ts`) are the target pattern — screens
  and the two large lib files should be decomposed toward it (item #2).
- **`apps/desktop` is an intentional stub** (per `TODO.md`, "Desktop app fate... decide
  rebuild or deprecate after v0.2 mobile dogfooding") — not a structural problem to fix now,
  but an agent should know not to invest effort there without checking `TODO.md` first.
- **Workspace boundaries are otherwise clean**: `packages/shared` → consumed by both apps,
  no circular deps observed, `tsconfig.base.json` is shared correctly.
