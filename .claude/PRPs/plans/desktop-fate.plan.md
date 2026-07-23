# Proposal: deprecate `apps/desktop` (decision doc — awaiting CONFIRM)

Status: proposed, awaiting decision
Date: 2026-07-23
Origin: `TODO.md`'s long-standing "Desktop app fate" item ("`apps/desktop` is a
Tauri v2 stub. Decide rebuild or deprecate after v0.2 mobile dogfooding."),
carried unresolved across at least six session handoffs since 2026-07-12.
This is that decision's input — a concrete, evidence-based recommendation,
so the decision is approve/reject/amend rather than open-ended, mirroring
`.claude/PRPs/plans/completed/minimal-eslint-scope.plan.md`'s pattern.

## Correcting a stale claim first

Several prior handoffs (most recently 2026-07-18) described desktop fate as
awaiting a decision because "dogfooding has happened." That claim doesn't
hold up against the actual repo state, verified today:

- `apps/desktop` has exactly **9 commits in its entire history**. A real
  implementation existed briefly (`99056be` initial build →
  `354d113`/`9e89002`/`2ebbe50`/`1d45d93` — settings/keychain/storage
  fixes), built around a WebSocket pairing daemon called `navetted`.
- `navetted` was retired in v0.2 (OmniRoute + Syncthing replaced it,
  CLAUDE.md's "Resolved in v0.2" section). Desktop was **deliberately
  stubbed** at that point (`4baa81c`, "stub desktop pending v0.3, drop
  navetted ghost code") — every screen was ripped out rather than
  half-ported, specifically so the package would stay buildable without
  dragging dead code along.
- `apps/desktop/src/App.tsx` today is an 11-line placeholder page. Its own
  doc comment says: "The screens were ripped out... When v0.3 picks desktop
  back up, decide first: rebuild against OmniRoute... or deprecate the
  package entirely." The UI text tells users to "Use Obsidian on your
  workstation... for now."
- Zero commits have touched `apps/desktop` since the rename in `03aa087`
  (2026-06-04) — no feature work, no bug fixes, nothing in the ~7 weeks
  since.
- `find apps/desktop -name "*.test.*"` → 0 files. `apps/desktop/package.json`
  test script has been `vitest run --passWithNoTests` since `1a43405`.

So "dogfooding" — if it happened at all — was of the pre-v0.2 `navetted`
implementation, which no longer exists in any form. There is no dogfoodable
desktop app today, and hasn't been for the entire v0.2 cycle. This doc
proceeds on the corrected premise: **desktop has had zero real usage since
becoming a placeholder**, not "dogfooding happened, now decide."

## What desktop actually costs today

- One of four required `gate` jobs (`.github/workflows/ci.yml:170-172`,
  `needs: [shared, mobile, desktop, mobile-android]`) — every PR pays for
  it.
- What it actually verifies (`.github/workflows/ci.yml:63-78`): `tsc &&
  vite build` against a placeholder page, plus a vitest run with
  `--passWithNoTests` (i.e., verifies zero tests, trivially). It is a
  "the stub still compiles" check, not a functional smoke test — it cannot
  catch a real regression because there is no real behavior to regress.
- Low but nonzero maintenance drag: `packages/shared` changes must stay
  desktop-import-compatible (already a stated constraint — "must stay
  importable by both apps without pulling in RN- or Tauri-specific code");
  any future shared-package refactor pays a small tax keeping this stub
  green for no functional benefit.

## What mobile looks like by comparison

Five capture modes (idea/journal/person/photo/audio), share-target
integration, a persistent-notification capture surface, Search (Phase 1 +
2), TagBrowser, Settings with two selectable LLM backends, Karakeep export,
an offline capture + pending-sync queue, ~600+ well-factored `lib/*.ts`
modules each with co-located tests, 1117 passing tests total, and
continuous feature work across every session handoff in this doc's history
(50+ days of active development, most recently the local-LLM backend and
Search Phase 2, both shipped this month). Mobile is unambiguously the
product; desktop has been static scaffolding since 2026-05-17.

## Options

### Option A — Deprecate (recommended)

Remove `apps/desktop` from the repo and the CI `gate`. Concretely:
- Delete `apps/desktop/` entirely (or, if a soft landing is preferred,
  move it to a `deprecated/` or archive branch rather than delete outright
  — see Open decisions below).
- Drop the `desktop` job from `.github/workflows/ci.yml` and remove it from
  `gate.needs` — shrinks the required-check surface and the ~45s it costs
  per PR run today.
- Update `CLAUDE.md`'s workspace list and the `## Workspaces` section to
  drop the `apps/desktop` bullet; update the root `package.json`'s
  `desktop`/`desktop:tauri` scripts if they're still wired to `npm run`.
- `packages/shared` keeps its existing "no RN/Tauri-specific code, stays
  importable by both apps" constraint documentation as historical context,
  or that note gets dropped too since there's no longer a second consumer
  to protect against regressing for.
- Cost: near-zero engineering effort (deletion + CI config edit + doc
  update, well under an hour). Reversible via git history if a future
  desktop need arises — nothing about this is a one-way door.

### Option B — Rebuild against OmniRoute

Mirror the mobile capture flow on desktop: idea/journal/person capture at
minimum, wired to the same OmniRoute (and now local-LLM) dispatcher pattern
mobile uses, writing to the same Syncthing-shared vault via a Tauri
filesystem API instead of SAF. Realistic scope: several screens, a capture
form, settings screen, a test harness from scratch (desktop currently has
none). Rough estimate: 2-4 weeks of focused work for a minimally-viable
parallel surface, informed by mobile's `lib/*.ts` module count as a proxy
for the logic that would need porting or reimplementing.
- Cost: real, multi-week investment with no user-demand signal backing it
  (no evidence anyone has asked for or used a desktop capture surface;
  "use Obsidian on your workstation" already covers read/edit — the actual
  gap would only be *capture*, not consumption, and capture-on-desktop's
  use case is unclear versus capture-on-phone-then-sync, which is the
  entire premise of the vault-plus-Syncthing architecture).

### Option C — Keep as a build-only placeholder (status quo)

Change nothing; leave the decision deferred again. This is the de facto
current state and isn't really a decision — it's what happens if this doc
is rejected without an alternative. Costs: the CI tax above, continues
indefinitely, and the TODO item keeps resurfacing in every session handoff
(as it already has six times).

## Recommendation

**Option A — deprecate.** The evidence doesn't support continued
investment or even continued CI cost for a placeholder with no usage
signal and no functional behavior to protect. Mobile is the product;
Obsidian-on-workstation already covers the read/edit use case desktop
would otherwise serve. If a genuine desktop-capture need surfaces later
(it hasn't in the ~7 weeks since the stub landed, nor in the '~2 months
before that when it had real screens and presumably some early use), it's
a fresh `git log`-visible decision to make with actual demand evidence
behind it, not a resurrection of dead code.

## Open decisions

- **Delete outright vs. archive**: hard delete is simpler and matches this
  repo's general preference for not carrying dead code, but an archive
  branch (`archive/desktop-stub` or similar) costs nothing and preserves
  the option to resurrect without digging through history. Recommend hard
  delete — `git log` already preserves everything; a named archive branch
  is one more thing to remember exists and keep from bit-rotting.
- **Root `package.json` scripts**: `npm run desktop` / `npm run
  desktop:tauri` (per CLAUDE.md's command list) would need removal or a
  clear "removed, see CLAUDE.md history" stub — decide at implementation
  time based on whether anyone has a muscle-memory habit of running them.

## Decision requested

- **Approve** → one PR implementing Option A (delete `apps/desktop`, drop
  the CI job, update `CLAUDE.md`/root `package.json`), through the
  devils-advocate + CI-gate loop as usual.
- **Amend** → pick Option B or C instead, or adjust Option A's scope
  (e.g., archive instead of delete) here first.
- **Reject** → desktop stays as-is; this doc moves to `plans/completed/`
  with a "rejected, keeping placeholder" status so the item stops
  resurfacing in every handoff — though note that "reject and do nothing"
  is functionally Option C, already covered above.
