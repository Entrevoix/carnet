# Session handoff — 2026-08-06 (Enhance action + resizable widget shipped, `main` finally protected)

## State at handoff

`main` is at **`8efea5d`**. Everything from this session is merged: two features
(#131, #132), the follow-up data-loss fixes (#133), and this handoff (#134).
Nothing from this session is left open.

Suite: **1622 mobile tests**, 272 `verify:capture-flow`, 12 `@carnet/shared`.
`tsc --noEmit` clean, lint clean, `:app:compileDebugKotlin` BUILD SUCCESSFUL.

Devices used: Pixel 9 Pro Fold `4A111FDKD0000C` (comet) and Pixel 10 Pro Fold
`57211FDCG0023C` (rango).

## Shipped this session

### `main` is branch-protected (this is the big one)

`main` had **no protection at all** — `GET .../branches/main/protection`
returned 404 while CLAUDE.md claimed the `gate` job was "required by branch
protection." That gap is what let PR #126 squash-merge with `mobile-android`
still pending. CLAUDE.md is now accurate rather than aspirational.

Config: required check **`gate`** (non-strict), PR required, **0** approving
reviews, force-push and deletion blocked, **`enforce_admins: false`**.

Two deliberate choices, both because this is a one-committer repo:
- **0 approvals** — GitHub forbids self-approval, so requiring even one review
  would permanently block the owner from merging their own PRs.
- **admins can bypass** — leaves an escape hatch if `mobile-android`'s Android
  toolchain goes flaky and freezes `main`.

`apk` is deliberately NOT required; it is advisory by design. Expect
`mergeStateStatus: UNSTABLE` on a PR whose only pending check is `apk` — that
is the normal, mergeable state, not a problem.

### `10cbb0b` — Enhance action (#131)

A `⋮` → **Enhance** row on any saved note. Sends the prose body to a dedicated,
usually stronger model, enriches it with real-world fact about the places and
organizations named, and rewrites the body in place. Frontmatter and the
`# Title` are split off before the call and re-attached after.

Routing is a setting, never a hardcoded model id: `enhanceProviderId` picks the
endpoint, `enhanceModel` picks the model on it — so captures stay on a fast
cheap model while Enhance reaches for a better one through the same provider.
The Settings row browses the endpoint's live catalogue (596 models on the
configured OmniRoute) by reusing `ModelBrowserModal` + `llmClient.listModels`.

**`resolveEnhanceProvider` deliberately INVERTS `resolveVisionProvider`'s
precedence.** Vision prefers the active entry whenever it is capable; Enhance
must let a configured entry WIN, or the setting silently never takes effect.
There is a dedicated test guarding exactly that, because copying vision's
ordering fails with every test still green.

Four defects the **device pass** caught that unit tests did not:
1. Paired-binary links were being sent to the model, which dropped them —
   orphaning the .jpg while the note lost its only reference.
2. URLs were silently dropped (a live run lost three from a real note,
   including an unreconstructable Maps short-link). Prompt now demands
   verbatim preservation AND `droppedUrls()` re-appends any casualties.
3. The 20s `FETCH_TIMEOUT_MS` gutted the feature's purpose — a reasoning model
   took 36s and was cut off, so "pick a better model" failed *because* the
   model was better. Enhance now has its own 120s ceiling; capture untouched.
4. `withFallbackChain` let an unconfigured fallback's config error replace the
   primary's real one ("Local LLM model not configured" when the truth was
   "OmniRoute timed out"). Shared by every `enrich*` path, so that masking was
   reachable from any capture with a half-configured fallback.

### `e63d951` — Resizable capture widget, 4×1 ↔ 2×2 (#132)

One provider, one picker entry, same four capture deep links. Two sizing paths
because **minSdk is 24**: a size→RemoteViews map on API 31+, and
`onAppWidgetOptionsChanged` below that, guarded so the two cannot both rebind
and flicker.

Extracted `ProviderRoleRow`, `EnhanceRoleSection`, `DeleteProviderDialog`,
`AddProviderDialog` purely to keep `LlmProviderSection.tsx` under the 800-line
ceiling (it ended at 796).

### `35e90c3` — data-loss fixes (#133)

Three defects an **independent read-based review** (`/codex review`) found that
neither my own review nor the device pass did. Two are silent data loss:

1. **Title deletion.** `splitFrontmatter` ends its header at the newline
   closing `---`, so an Obsidian-formatted note (`---…---\n\n# Title`) yields a
   body STARTING with a blank line. The anchored `/^#/` missed the H1, so it
   went to the model as prose — and the prompt forbids headings, so the model
   deleted it. **Every note in that layout lost its title, silently.**
2. **Concurrent edits clobbered.** The write was unconditional against a
   screen-load snapshot, across a call now up to 120s. Now mirrors
   `promoteIdeaOnDisk`: mtime baseline → `readNote` for CURRENT content →
   `updateNoteIfUnchanged`. Observed live: a note was edited on-device during
   an in-flight Enhance.
3. **Widget 4×1 unplaceable on Android 7–11.** `min*` is a floor and must admit
   the smallest shape per axis; `minHeight=110dp` demanded two rows. Back to
   40dp.

Each regression test was verified to fail without its fix.

## Open — pick up here

### Open PRs (all pre-existing; nothing from this session is open)

- **#130** — session handoff 2026-08-05. Carries the `.gstack/` `.gitignore`
  rule; until it merges, `.gstack/` shows as untracked in every `git status` on
  `main`.
- **#128** — `feat(capture): warn up front when the card scanner has no vision`.

### Stale local branches

Seven locals are squash-merge artifacts (merged via PR, commits not ancestors
of `main`): `docs/reconcile-todo`, `feat/enhance-prose-action`,
`feat/widget-2x2-resizable`, `fix/crash-log-audit-followups`,
`fix/release-script-multi-device`, `fix/saf-findsubdir-and-shared-coverage`,
`refactor/mdcrm-deslop`. Safe to delete.

**Do NOT PR these two as-is** — both are based on ancient `main` and their
diffs are mostly deletions of files that exist today:
- `feat/unicode-slugify` — 19 commits behind; a genuinely good 2-file fix
  (NFD-fold Latin diacritics so `Dvořák` stops becoming `dvork`, and `Łódź
  street` stops becoming `od-street`). **Cherry-pick `5af4e2d` onto current
  `main`** rather than merging the branch.
- `worktree-agent-a8edeba34f023a175` — 119 commits behind, from Jul 4; its
  work almost certainly landed via `search-phase2-fulltext.plan.md`.

## Verification ladder for native surfaces (learned the hard way)

`apps/mobile/android/` is **gitignored** and fully regenerated by
`expo prebuild`. The config plugins ARE the native source; a hand-edit to the
emitted Kotlin is invisible to git, un-reviewable, and reverted on next
prebuild.

Each rung catches what the one above cannot:

| Rung | Proves | Misses |
|---|---|---|
| `verify-notification-and-widget-prebuild.sh` | files emitted, layout ids match | whether it compiles or inflates |
| CI `mobile-android` (in `gate.needs`) | Kotlin compiles | whether the layout inflates |
| A real device | it actually works | — |

An unsupported view in a RemoteViews layout compiles and packages fine, then
throws `InflateException` on a real home screen. Use nested `LinearLayout`;
`ConstraintLayout` is NOT supported.

`prebuild --clean` wipes `local.properties`, so a local Gradle run needs
`export ANDROID_HOME="$HOME/Android/Sdk"` first or it fails with "SDK location
not found".

## On-device QA mechanics (corrects a previously-recorded quirk)

**`input -d 0` is NOT the fix for the swipe-up gesture stealing taps.** That
advice was wrong and caused real harm this session: on comet, `screencap -d 0`
errors with *"Display Id '0' is not valid"* (real ids are
`4619827677550801152/…153`), and `input -d 0 tap` routed taps somewhere other
than the focused window — it opened **Google Authenticator** and walked into its
export screen. Blind coordinate tapping after one mis-hit compounds, because
every later tap lands in whatever app is now focused.

Correct procedure:
- Assert focus **before every tap**: `dumpsys window | grep mCurrentFocus` must
  show `com.ventouxlabs.carnet`. Abort the sequence if it does not.
- Take coordinates from `uiautomator dump` **of the Carnet window only**, tap
  bounds-centers with plain `input tap`, and delete the dump afterwards (it can
  contain other apps' text if focus wandered).
- Treat an unexpected `mCurrentFocus` as stop-and-reassess, never as something
  to tap your way out of.
- **The focus guard cannot catch overlays.** A picture-in-picture video call
  renders above Carnet without taking focus, and sat exactly on the `⋮` button.
  Check for PiP before driving the top-right corner.
- `screencap` on the Fold prepends a `[Warning] Multiple displays…` line to the
  PNG; strip to the `\x89PNG` magic bytes.
- comet's USB drops mid-operation repeatedly (3× this session). `adb reconnect`
  does not recover it — needs a physical replug.
- **With two devices attached, pin the serial** (`adb -s <serial>`); a bare
  `adb` is ambiguous and `android:release` installs to both.

## Known gaps

These three shipped to `main` unproven. None blocks anything; each is a claim
currently resting on reasoning rather than observation.

- **The API 24–30 widget path has never run.** Both `minHeight=40dp` (#133) and
  `onAppWidgetOptionsChanged` (#132) are reasoned from the documented sizing
  rule — both phones on the rig run Android 17, so there is nothing to execute
  it. Dropping to 31+-only (older devices keep the 4×1) deletes untested code
  if that is preferred to carrying it.
- **The 2×2 layout has never been placed on a home screen.** Widget placement
  is a launcher drag-and-drop that resists automation, and it is the only rung
  that catches an `InflateException`.
- **`## Links` backstop never exercised live** — both successful Enhance runs
  were on notes without URLs.
