# Session handoff — 2026-08-13 → 2026-08-17 (eight PRs merged, on-device validation, model-browser fix)

## State at handoff

`main` at **`a517e06`** (#148). Suite: **1846 mobile / 12 shared** tests passing,
capture-flow gate 298/298, typecheck + lint clean, CI green on every merge.
**Zero open PRs; zero stale local branches** (16 dead ones deleted in a
housekeeping pass — all squash-merged content, nothing lost).

Device: Pixel 9 Pro Fold (`4A111FDKD0000C`), adb-connected, running a
**release-signed build of `a517e06`** (installed from CI's `apk` artifact —
local Gradle release builds fail in this environment on Maven Central fetch
timeouts; use the CI artifact, run `gh run download <run-id> -n
carnet-release-apk`). The debug-signed install that previously blocked
release upgrades was wiped (with the user's approval; only QA test data was
lost) — from here on, `adb install -r` upgrades work in place.

## Shipped this session (8 PRs, oldest first)

- **#109** — old session-handoff doc (2026-07-28), had sat open two weeks.
- **#142 `d076ccf` — edit-before/after-enrichment.** Non-blocking Edit during
  the enrichment window (all 3 modes) + generalized Re-enrich for saved
  Idea/Person notes (Journal deliberately excluded — day-file granularity makes
  whole-file re-enrich destructive). Merged after resolving a 3-way conflict
  against main (`NoteActionsSheet` ⋮ menu + two test files, all additive).
  Its own report documents 5 review rounds / 14 findings; round 5 used
  mutation testing.
- **#143 `7c9690b` — journal places** (was already green at session start).
- **#144 `1ac93bc` — attach photo from camera** (`⋮` → Attach photo →
  `Photos/` write → embed append through the enhanceProse mtime-guard spine).
  4 review rounds (Codex CLI + devils-advocate alternating) closed 7 findings,
  the dismiss-mid-capture race needing three successively tighter fixes
  (reopen-only → dismiss-without-reopen → synchronous `handleDismiss`, because
  a passive effect loses to a same-tick promise).
- **#145 `388a3e3` — Unicode slugify** (NFD fold replacing the French-only
  accent map). Resurrected from a forgotten local branch during housekeeping.
  Its "NOT YET MERGEABLE: confirm Hermes has normalize()" blocker was resolved
  two ways: source-level (Hermes delegates to `java.text.Normalizer` via JNI —
  AndroidUnicodeUtils.java), then empirically (see device validation below).
- **#146/#147 — doc reconciliation.** TODO.md was 3 shipped-items stale
  (#111 queue encryption, #138 connection-test fix, #145). CLAUDE.md's
  structural notes told a *backwards* story (called RecentDetailScreen the
  last file over 800 lines at ~1614 — it's 893 and CaptureScreen at 1057 is
  now the largest; also still pointed agents at `lib/omniroute.ts`, deleted in
  #120). Both now carry "numbers drift — `wc -l` the file" caveats.
- **#148 `a517e06` — model-browser flicker fix** (see below).

## The model-browser bug (#148) — worth remembering the shape

User report: filtering the Settings model browser "pulses and will not list a
steady result." Root cause: **duplicate React keys** — llm.grepon.cc serves
repeated model ids (4 when checked), `filterAndSplitModels` passed them
through, `ModelBrowserModal` keys its FlatList on the id. Filtering *surfaces*
it (collapses 1273 rows until both copies co-render); it doesn't cause it.
The user's actual query was `mini` — which matches ge-**mini**-ni, dragging in
the whole `gemini/*` family where every duplicate lives. `gpt` matches none
and never flickered, which is why it looked erratic.

Fix: dedupe (first occurrence wins) inside `filterAndSplitModels`. The
devils-advocate follow-up added the constraint that makes collapsing *safe*
(the id is the entire identity carnet carries — `applyPickedModel` stores the
string, `llmClient` sends it verbatim; revisit if the browser ever renders
per-model metadata) and mutation-tested the suite: 4 mutants, 0 survivors,
including keep-last-occurrence (killed by exactly 1 test — its sole guard).

**Deferred by recorded decision** (in #148's PR body): a one-shot
duplicate-count warning at the catalog fetch site in `LlmProviderSection` —
the flicker was accidentally the only signal the gateway serves dupes, and the
fix silences it.

## On-device validation — done vs still open

Done (this session, on the release build of `a517e06`):
- **#145 Hermes blocker CLOSED**: `slugify()` runs `.normalize("NFD")`
  unconditionally on every capture; captures save fine; Diagnostics shows "No
  crashes recorded." Multi-word slug verified (`vault-redirect-verification-note`).
- **#148 verified conclusively**: browser shows **"1269 models"** (raw catalog
  is 1273 — exactly the 4 dupes collapsed) and **"263 matching 'mini'"**
  (predicted 263); six consecutive uiautomator snapshots of the filtered list
  byte-identical (13 rows, same md5) — the list is steady.
- **#144 partially verified**: `⋮` → Attach photo row present; permission
  gate shows "Camera permission required" **with the Library button still
  visible and tappable** (the round-4 review finding, confirmed fixed);
  Library opens the system picker. Session ended mid-pick.
- Vault reconfigured post-wipe: SAF grant to `primary:Documents/carnet`
  (typed paths do NOT work — `isn't writable`; must use Pick folder). Active
  provider: OmniRoute preset @ `https://llm.grepon.cc`, model
  `gemini/gemini-flash-lite-latest`, no API key (gateway is unauthenticated).

Still open, in priority order:
1. **#144 finish**: pick `/sdcard/Pictures/Łódź Dvořák café.jpg` (staged, in
   the Pictures album, media-scanned) from the Library picker → verify embed
   appended to the note body, file lands as `Photos/lodz-dvorak-cafe.jpg`
   (this doubles as the #145 diacritic-fold check), frontmatter byte-intact.
   Then grant camera permission and exercise the shutter path + the
   dismiss-mid-capture guard.
2. **#142 on-device**: needs enrichment slow enough to expose the Edit
   window. Recreate the prior "QA Slow" pattern: custom provider at
   `https://192.0.2.1` (TEST-NET-1, black-holes → long timeout), capture an
   Idea, tap Edit mid-flight, verify draft restore + the late result being
   ignored + resubmit rewriting the SAME file (no `-2.md` duplicate).
3. **#148 flicker**: verified steady; user's eyes on it is a nice-to-have.

## Model bake-off (for the enrichment provider choice)

12 entry-tier models × 3 cases × 3 repeats against carnet's REAL idea prompt,
scored against the REAL gate (`normalizeFrontmatter` requires created/status/
tags keys). Clean 9/9: gemini-3-flash-preview (both routes),
gemini-3.1-flash-lite-preview, **gemini-flash-lite-latest** (picked: stable
alias vs -preview churn, cheapest tier, vision-capable, and carnet is
save-first so its 5.7s latency is invisible), gemma-4-31b, gpt-5-mini.
Fallback recommendation if configuring one: `openrouter/anthropic/claude-haiku-4.5`
(9/9, 2.1s, different vendor+route; cosmetic tag-drop only). **Avoid `ddgw/*`
entirely** — DuckDuckGo-AI-Chat-backed, rate-limits immediately.
Note: gpt-5-mini "followed injection" in the first harness run was a FALSE
POSITIVE (it quoted "PWNED" while describing the attempt; frontmatter intact).
All models held carnet's injection guard.

## Operational notes (hard-won this session)

- **mdcrm `inbox.test.ts` is flaky in CI** (temp-dir `ENOTEMPTY` race +
  timeout). Failed once on #146, passed clean on rerun and on later runs.
  `gh run rerun <id> --failed` — but only after the whole run completes
  (`apk` takes ~19 min and blocks the rerun API). Worth a real fix if it
  keeps costing reruns.
- **uiautomator + screencap work fine on this foldable** (prior sessions'
  dual-display trouble did not recur; device stayed in closed state).
  Helper at scratchpad `ui.sh` (dump/find/tap/list). Two USB drop-offs
  mid-session — physical, re-seat the cable.
- `adb shell input text` cannot type non-ASCII (throws, 0 chars) and
  truncates at the first space unless `%s` is used. Unicode into the app:
  share intent (`am start -a android.intent.action.SEND ... --es
  android.intent.extra.TEXT '...'` — quote for the DEVICE-side shell) or a
  Unicode-named file via the picker.
- The share-intake path names files `shared-text-<timestamp>.md` — it does
  NOT exercise slugify on content; only Idea-mode capture does.
- llm.grepon.cc `/v1/models` and `/v1/chat/completions` are reachable
  unauthenticated from this workstation; the gateway silently upgrades stale
  model aliases (observed `gemini-2.0-flash-lite` → served `3.1-flash-lite`).

## Standing constraints (unchanged, see CLAUDE.md)

No SQLite; no .env; frontmatter byte-compat; squash-merge; three-rule ESLint;
attribution disabled in commits; `com.ventouxlabs.carnet` package id.
