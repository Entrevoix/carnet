# Session handoff — 2026-07-28 (crash-log audit follow-ups, release-script fix, TODO reconciliation)

## State at handoff

Continuation of `2026-07-27-crash-log-diagnostics-shipped.md`. Three PRs opened and
merged this session; `main` at **`53ffdf7`** (#106 `bdd12bb` → #107 `e220da9` → #108
`53ffdf7`). Suite: **1156 tests** passing on merged `main` (was 1143), `tsc --noEmit`
clean, lint clean, CI green on every merge. Both Pixels (`57211FDCG0023C` Pixel 10 Pro
Fold, `4A111FDKD0000C` Pixel 9 Pro Fold) are adb-connected and carry a release-signed
build of `main`.

**One branch is in flight and deliberately unmerged:** `feat/unicode-slugify`
(`5af4e2d`) — see "In flight" below. It is blocked on a device check, not on review.

## Shipped this session

- **#106 `bdd12bb` — crash-log hardening (10 audit findings).** A `/devils-advocate` run
  found the working tree clean, so the scope became an audit of the *last shipped work*
  (`9eb1d0e` + `9e94ca7`) rather than a diff review. Findings, all fixed:
  - **The fatal path probably lost the crashes it exists to capture.** The global handler
    fired `recordCrash` unawaited then immediately handed off to RN's default handler,
    which tears the app down — so the AsyncStorage write raced teardown. Now bounded by a
    250ms `Promise.race` before default handling. **The prior test actively hid this**: it
    called `await flushMicrotasks()` *after* invoking the handler, so it passed either way.
  - **`CrashBoundary`'s fallback pointed at an unreachable screen.** It replaces the whole
    navigation tree, so "saved to Settings → Diagnostics" named a screen that cannot be
    opened while the boundary is tripped. It now carries its own "Copy error details"
    button and says the log is reachable *after a restart*.
  - **Repeated crashes flushed distinct history.** Every "Try again" tap re-recorded the
    same error, evicting unrelated crashes from a 20-slot buffer. Consecutive repeats now
    collapse into a counted entry, keyed on message **and** stack so unrelated failures
    sharing a message stay separate.
  - **Unbounded record size, silent failure.** `String(error)` on an arbitrary thrown
    value can be megabytes; one oversized record would fail its own write and re-fail on
    every append after it (it stays in the buffer and gets re-serialized), silently
    killing the log. Now clamped at 1000/8000 chars.
  - Privacy wording no longer claims "nothing has ever been sent off-device" directly
    above a button that writes to the system clipboard.
  - Plus `App.tsx` re-indentation and +13 tests.
- **#107 `e220da9` — `build-release-apk.sh` is serial-aware.** It checked *whether any*
  device was connected then ran a bare `adb install`, which dies with "more than one
  device/emulator" once a second phone attaches — **after** a full Gradle build succeeds.
  Every adb call is now `-s <serial>`; all connected devices get the APK; `ANDROID_SERIAL`
  narrows to one and is validated *before* the build; only state `device` counts; one
  device failing no longer aborts the rest.
- **#108 `53ffdf7` — TODO.md reconciled against git history.** Four entries were wrong:
  Browse/search Phase 2 was listed as deferred after shipping in #104; the on-device
  Gemma item said to "add a `localLlm.ts` sibling behind the seam" when that file already
  exists (#105, as an HTTP client to a local server rather than a native in-process
  model); the Settings connection test is half-shipped (local-LLM has `healthCheck()` and
  a button, OmniRoute has neither); and cross-capture linking is largely superseded by
  `lib/relatedNotes.ts`. Adds a "Resolved since Stage 2" section, a reconciliation date,
  and an explicit "re-verify before acting" instruction.

## In flight — `feat/unicode-slugify` (`5af4e2d`), NOT merged

`slugify()` in `writer.ts` transliterated a hand-listed French accent set and dropped
everything else, so "Łódź street" became "od-street" and "Dvořák" became "dvork" — and
once enough characters were lost, callers fell back to a generic stem and the note lost
its title entirely. The branch NFD-decomposes and strips combining marks (folding every
Latin diacritic, not a remembered subset), keeping a small `SPECIAL_FOLDS` map for the
atomic letters decomposition cannot handle (ß, æ, œ, ø, ł, đ, ð, þ, ħ). Written TDD-first:
4 new tests, 2 genuinely red before the fix. Gates pass locally — 1160 tests, typecheck,
lint.

**Why it is not merged: `String.prototype.normalize` is unverified under Hermes.** Only
`hermesc` (the compiler) ships for Linux; the runtime binary in
`node_modules/react-native/sdks/hermesc/` is macOS-only, so it cannot be evaluated from
this workstation. Hermes trims sizable Unicode tables, and if `normalize` is absent the
call throws and **capture breaks for every accented title** — strictly worse than the bug
being fixed. Confirm on a device (build, capture a note titled e.g. "Dvořák café", check
the written filename) before merging. If it turns out to be missing, the intended
direction is an extended explicit fold map covering the scripts actually in use — same
coverage, no runtime dependency — not abandoning the item.

## Process notes for the next session

- **The instrumented-build technique worked and is reusable.** Verifying `CrashBoundary`
  and the fatal path needs an actual crash, and the app deliberately has no trigger. The
  approach: add temporary uncommitted trigger buttons, build them **release-signed with
  the shared keystore** so the APK upgrades in place (`adb install -r`) with *no uninstall
  and no settings wipe*, verify, then rebuild clean and reinstall. A debug-signed variant
  would have forced an uninstall and cost the device's Settings config.
- **The fatal-flush fix is verified against a real teardown**, not just mocks: triggering
  an uncaught fatal killed the process (pid 2655 → gone), and on relaunch Diagnostics read
  "2 crashes recorded". That is the single most important piece of evidence from this
  session — the old code would most likely have lost that record.
- **Drive the device atomically.** A dump-then-tap split across two Bash calls tapped a
  stale coordinate and silently did nothing (the app appeared to navigate Home on its
  own). Dumping the UI, computing bounds, and tapping *within one command* fixed it.
  Relais also stole foreground twice mid-run — `am start -n` after `KEYCODE_HOME` is more
  reliable than `monkey`.
- **TODO.md drift is a recurring failure mode, now documented in the file itself.** Two
  items were listed as deferred after shipping; two more described remaining work that no
  longer matches the code. This is the second time this pattern has cost a session
  (cf. `feedback_verify_git_log_before_roadmap`). The file now carries a reconciliation
  date and an explicit "re-verify before acting" instruction.
- Two audit claims of mine were wrong and were corrected during implementation: the
  ring-buffer eviction test already existed, and a repeat-collapsing test I wrote asserted
  behavior the code correctly does *not* have (two `new Error("a")` calls have different
  stacks, so they don't collapse — which is right).
- **`mobile-android` flaked for the first time, on a docs-only PR.** #108 failed in the
  `.github/actions/android-toolchain` composite action (setup, not compilation), which
  **skipped `gate`** and blocked the merge. A plain re-run of the failed job passed with
  no code change. This is the scenario CLAUDE.md anticipates when it notes that demoting
  `mobile-android` from `gate.needs` is a one-line revert — one flake is not grounds to do
  that, but if it recurs on unrelated PRs, that note is the escape hatch. Retry once
  before concluding anything; never merge around a red or skipped `gate`.

## Open / user-side

- **Relais now has a model loaded** (`Gemma 4 E2B-it`, Tensor G5) on the Pixel 10 —
  observed directly this session. The local-LLM **live send-and-observe** check has been
  blocked across two handoffs on `NOT_DOWNLOADED`; that blocker appears gone. Still do not
  fix Relais from a Carnet session — separate repo at `~/Documents/vibe-code/relais`.
- **Two decisions are open, both flagged rather than made:**
  - The **fatal deferral shipped ungated** (not `__DEV__`-conditional). Device evidence
    supports it, but the tradeoff — a wedged JS thread could lose the redbox — was never
    adjudicated. One-line change to gate it.
  - **On-device Gemma native phases: keep or drop.** Re-framed in #108. Relais already
    delivers disconnected enrichment through the `dispatcher.ts` seam, so the native
    module + ~1.5GB bundled model buys little for real app-size and maintenance cost.
- **Karakeep test bookmarks** — still awaiting manual delete (needs Karakeep access).
- **OmniRoute Mistral key deletion** — still awaiting manual delete on the dashboard
  (`192.168.1.20`).
- `.agent_native/agent_roadmap.md` **item #5** (plan-lifecycle status markers) remains
  untouched — still needs a human judgment call per plan.
- Cheapest genuinely-open engineering item, given both Pixels are attached: the **person
  camera capture pipeline** integration test (`CardScannerModal` → `ocrCardViaVision()`),
  wired but never verified on device.

## Agreed plan for autonomous iteration (not yet started)

The user asked to work the remaining open items unattended — plan → TDD → devils-advocate
→ merge if clear. Triage, because most open items are **not** automatable:

- **Automatable:** Unicode slugify (in flight, above); OmniRoute connection test (mirror
  `localLlm.healthCheck` into `omniroute.ts` + wire the Settings button); encrypt queue
  payloads at rest.
- **Not automatable, and why:** person camera pipeline and card auto-detection need a human
  to physically point a camera at a business card; iOS share extension has no `ios/` dir
  and no Mac; bidirectional-sync watcher and multi-vault need design decisions (TODO calls
  multi-vault premature); roadmap #5 is a human judgment call by definition;
  Karakeep/OmniRoute cleanups need the user's credentials on external services; and the
  Gemma keep-or-drop and fatal-deferral-gating questions are decisions, not tasks.

Guardrails agreed for unattended merging:
- Merge only when **all** hold: `gate` green, no CRITICAL/HIGH from devils-advocate, and
  typecheck + lint + full suite pass. Otherwise leave the PR open with the findings.
- **Queue encryption gets a PR but no auto-merge** — crypto plus PII plus a migration over
  existing plaintext entries; a wrong migration makes previously-queued captures
  permanently unreadable. That needs human eyes, not a green check.
- CI flake policy: retry a failed job once; if it fails twice, stop and leave it. Never
  merge with `gate` red or skipped.

Note that unattended continuation requires `/loop` — the agent only acts while a turn is
running, so without it the queue stops at the end of the current turn.
