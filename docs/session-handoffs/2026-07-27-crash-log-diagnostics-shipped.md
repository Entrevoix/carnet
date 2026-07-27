# Session handoff — 2026-07-27 (local crash log shipped, devils-advocate fix, release build verified)

## State at handoff

Continuation of `2026-07-26-desktop-deprecation-shipped.md`. All commits pushed to
`main` (`9e94ca7`), **CI green on both pushes** (`gh run 30231883011` 19m22s,
`gh run 30232562422` 16m24s). Suite: **1143 tests** passing, `tsc --noEmit` clean,
lint clean. A release-signed APK built from `9e94ca7` was installed and verified on
two connected devices (Pixel 9 Pro Fold `4A111FDKD0000C`, Pixel 10 Pro Fold
`57211FDCG0023C`).

## Shipped this session

- `2ace11f` **Stopped tracking `.claude/scheduled_tasks.lock`** — a runtime lock file
  (sessionId/pid/timestamp, rewritten every session) that was accidentally committed in
  the initial baseline and has shown as "modified" in every session since. Added to
  `.gitignore`, `git rm --cached`. Working tree is finally clean between sessions.
- `9eb1d0e` **Local crash/error log** (`.claude/PRPs/plans/completed/self-hosted-sentry.plan.md`,
  approved same session). The app had **zero crash telemetry** — every real defect in
  this project's history (STT code-9, the share-intent crash loop, the SAF
  folder-duplication race) was found by manual `adb logcat` reproduction, not anything
  automatic. The originally-proposed "self-hosted Sentry" was rejected as disproportionate
  (a 6+ container stack for a single-developer dogfooding project) in favor of **Option B**:
  - `lib/crashLog.ts` — AsyncStorage ring buffer, capped at 20, writes serialized.
  - `lib/crashReporting.ts` — `installGlobalCrashHandler()` chains onto RN's
    `global.ErrorUtils`, idempotent, preserves the original handler (redbox/restart
    behavior unchanged).
  - `components/CrashBoundary.tsx` — render-phase error boundary wrapping the
    navigation tree in `App.tsx`, themed "Try again" fallback.
  - `components/DiagnosticsSection.tsx` — Settings → Diagnostics: view count,
    copy, or clear the log. Wired into `SettingsScreen.tsx`.
  - No server, no new infrastructure — consistent with the project's "no server, no
    database" hard constraint.
- `9e94ca7` **Devils-advocate fix, same session** — a `/devils-advocate` review of the
  `9eb1d0e` commit (5 rounds: correctness, error handling, performance, security, testing
  gaps) found that the concurrency fix applied during pre-commit review (serializing
  `writeQueue` to stop two near-simultaneous crashes from clobbering each other's write)
  had **narrowed `recordCrash`'s try/catch** to only cover the queued write, not record
  construction — so a hostile `error` whose `toString()`/`message` getter throws (a real
  possibility; both call sites feed it arbitrary thrown/caught values) would turn
  `recordCrash` into a rejected promise instead of honoring its documented "never throws"
  contract. Fixed with a two-layer try/catch (inner scoped to the write, so one bad write
  can't permanently poison the queue for every crash after it — a second regression the
  fix itself could have introduced; outer covering record construction), plus two
  regression tests. Also fixed in the same pass: `DiagnosticsSection` now shows "Copy
  failed" on a rejected clipboard write instead of failing silently, and the plan doc's
  privacy wording was tightened — "local-only, never sent off-device" describes the
  AsyncStorage store, not the "Copy log" action, which hands content to the OS clipboard
  (a cross-app-readable surface on Android).
- **Release build verified on-device**: `npm -w @carnet/mobile run android:release` from
  `9e94ca7`, release-signed via the shared keystore, 111 MB, 50s build (mostly cached).
  Installed to both connected devices via explicit `adb -s <serial> install -r` (plain
  `adb install` failed with "more than one device" — two Pixels were connected this
  session, a first — previously only one was ever seen).

## Process notes for the next session

- **Two devices are now adb-connected** (`4A111FDKD0000C` Pixel 9 Pro Fold,
  `57211FDCG0023C` Pixel 10 Pro Fold), not just one — update the standing assumption from
  `project_adb_device_available` (single Pixel). Any future `adb install`/`adb shell`
  command needs `-s <serial>` or it'll fail on device ambiguity. Worth confirming with the
  user whether both are meant to be dogfooding targets or if one is incidental.
- The devils-advocate loop found a real, fixable regression in a fix applied *during the
  same review cycle* (the concurrency serialization narrowed the try/catch scope) — a
  concrete instance of why the standing "review before commit, don't self-approve" mandate
  matters even for small follow-up commits, not just first-pass implementations.
- `.claude/scheduled_tasks.lock` should no longer show as modified in `git status` at the
  start of future sessions — if it does, something regressed the gitignore fix.

## Open / user-side

- **Local-LLM Settings UI on-device confirmation** — still not explicitly re-verified this
  session despite two devices now being available; carried over again from the
  2026-07-23/26 handoffs. Auto-memory `project_local_llm_verified_e2e` claims this was
  done 2026-07-23, but that predates several since-changed files — worth a fresh check
  now that a device is reliably connected.
- **Karakeep test bookmarks** — still awaiting manual delete (user-side, needs Karakeep
  instance access).
- **OmniRoute Mistral key deletion** — still awaiting manual delete on the OmniRoute
  dashboard (user-side, external service at `192.168.1.20`).
- No new forks or pending decisions opened this session — the self-hosted-sentry decision
  that was the prior handoff's implied next step is now fully closed (approved →
  implemented → devils-advocate reviewed → fixed → CI green → on-device verified).
