# CLAUDE.md — Carnet

Mobile-first knowledge capture for Obsidian. Android app (Expo/React Native) writes plain
Markdown into a Syncthing-watched folder; a Tauri desktop stub exists but is deferred (see
`TODO.md`). **No server, no database** — the vault (plain files) is the source of truth.

Read first, in this order, before making changes:
1. This file (build/test commands, hard constraints).
2. `docs/CODEMAPS/architecture.md` (+ sibling `backend.md`/`frontend.md`/`data.md`/
   `dependencies.md`) for layout and data flow.
3. `DESIGN.md` **before any visual/UI change** — it owns color/typography/spacing tokens
   and has its own "For AI tooling" rules section; do not restate or fork those rules here.
4. `TODO.md` for what's deliberately deferred (don't "fix" deferred scope without checking).
5. `.claude/PRPs/` for the plan → execute → report → review pipeline already in use, and
   `docs/session-handoffs/` for the latest cross-session state.

## Workspaces (npm workspaces monorepo)
- `apps/mobile` — Expo SDK 54 / React Native 0.81 / TypeScript — the primary surface.
- `apps/desktop` — Tauri v2 (Rust) + React — intentional placeholder stub; **has zero real
  tests today** (`test` script uses `--passWithNoTests`). Don't invest effort here without
  checking `TODO.md`'s "Desktop app fate" item first.
- `packages/shared` (`@carnet/shared`) — TS types + markdown helpers used by both apps.
  Build this first: mobile/desktop import it directly.

## Commands (verified against package.json — do not invent others)
```bash
npm ci                      # install (root)
npm run build:shared        # build @carnet/shared — required before mobile/desktop work
npm run mobile               # expo start (Metro dev server)
npm run desktop               # desktop app, Vite dev (web) mode
npm run desktop:tauri         # desktop app, Tauri native-shell dev mode

npm -w @carnet/mobile run typecheck   # tsc --noEmit (apps/mobile)
npm -w @carnet/mobile test            # vitest run (apps/mobile)
npm -w @carnet/desktop test           # vitest run --passWithNoTests (apps/desktop — no real tests exist yet)
npm -w @carnet/shared run typecheck   # tsc --noEmit (packages/shared)
npm -w @carnet/shared test            # vitest run (packages/shared)
```
There is **no lint script anywhere in this repo** (no eslint/biome config). The only
automated gates are `tsc --noEmit` and vitest, per workspace. Don't assume a lint step
exists or add one without discussing scope — it's a deliberate gap, not an oversight to
silently "fix."

## CI (`.github/workflows/ci.yml`)
Five jobs: `shared` → `mobile`, `desktop`, `mobile-android` (parallel, all
`needs: [shared]`) → `gate` (`needs: [shared, mobile, desktop, mobile-android]`,
required by branch protection). `mobile-android` (Expo prebuild +
`gradlew :app:compileDebugKotlin`) catches native Kotlin regressions in
`apps/mobile/plugins/*.js` config plugins; it was promoted into `gate.needs` on
2026-07-09 after three consecutive green runs (PRs #94–#96). If its Android
toolchain setup ever turns flaky and blocks unrelated merges, demoting it is a
one-line revert in `gate.needs` — note it in the job's in-file comment if so.
A sixth job, `apk` (advisory, not in `gate.needs`), attaches a release-signed
installable APK to every run's Artifacts — signed with the shared release
keystore (repo secrets `CARNET_KEYSTORE_*`; local mirror at
`~/.config/carnet/keystore.properties`, consumed by
`apps/mobile/scripts/build-release-apk.sh`). Debug-signed installs can't
upgrade to release-signed ones — uninstall once to cross over (see the
script header for the data-loss caveat).

## Hard constraints (non-negotiable — from `docs/session-handoffs/`)
- **No SQLite.** `expo-sqlite@55` is ABI-broken on Expo SDK 54. All persistence goes through
  AsyncStorage (`lib/queue.ts`, `lib/storage.ts`).
- **No `.env` files anywhere.** All runtime config (OmniRoute URL/key, Karakeep URL/key) is
  entered in-app via the Settings screen. API keys live in `expo-secure-store` /
  OS keychain (Tauri), never AsyncStorage/localStorage in plaintext.
- **Frontmatter must stay byte-compatible** with existing Obsidian vault files — verify
  against `lib/frontmatter.ts` and its tests before changing serialization.
- **Attribution is disabled in commits** (configured globally) — don't add co-author trailers.
- Branch from `main`; conventional commits (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`/
  `perf`/`ci`); **squash-merge** is this repo's convention; PR to `main`.
- Fix the implementation, not the test, unless the test itself is wrong.

## Reproducing bug reports
There is currently no fixtures/replay harness (tracked in
`.agent_native/agent_roadmap.md` item #1 — check whether it has since been built before
writing a one-off repro script). Until then: reproduce capture-flow bugs by writing a
targeted vitest test against the relevant `lib/*.ts` module (`writer.ts`, `omniroute.ts`,
`queue.ts`, `frontmatter.ts` are the usual suspects) rather than attempting to run the full
Expo/Android stack. `docs/smoke-test.md` is the manual, device-based checklist for anything
that can't be reproduced this way (voice/OCR/native share-sheet/Syncthing).

## Structural notes for agents
- `apps/mobile/src/lib/**` is well-factored: small, single-purpose modules, each with a
  co-located `*.test.ts` (~600 tests total across the repo). Follow this pattern for new
  logic.
- Several screen files in `apps/mobile/src/screens/` carry business logic inline and exceed
  this project's file-size norms (`RecentDetailScreen.tsx` ~1458 lines, `CaptureScreen.tsx`
  ~1039, `SettingsScreen.tsx` ~934), and `lib/writer.ts` (~1148) / `lib/omniroute.ts` (~710)
  are large too. **Zero screens have test coverage today.** When touching these files,
  prefer extracting the non-UI logic into a new `lib/*.ts` module with its own tests (as
  `lib/ideaSaveFirst.ts` and `lib/journalTagIndex.ts` already do) over adding more inline
  logic. See `.agent_native/agent_roadmap.md` item #2 for the full list.
- `packages/shared` has no circular dependencies on the apps; keep it that way — it must
  stay importable by both `apps/mobile` and `apps/desktop` without pulling in RN- or
  Tauri-specific code.

## Where deeper agent-native audit findings live
`.agent_native/agent_roadmap.md` — prioritized gaps (verification, reproduction,
structure) with acceptance criteria, ranked by human-attention saved per unit of effort.
