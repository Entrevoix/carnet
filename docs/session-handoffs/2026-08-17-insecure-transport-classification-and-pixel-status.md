# Session handoff — 2026-08-17 (part 3: insecure-transport classification, vault cleanup, Pixel still AWOL)

Continuation of `2026-08-17-cleartext-root-cause-device-emulator-validation.md` —
its "Next session, in order" list drove this segment.

## State at handoff

`main` at **`cc96963`** (#158), CI green through the full suite including the
advisory `apk` job on #157's run. No open PRs. Suites: mobile **1873/1873**
(baseline 1867 at segment start), shared 12/12, mdcrm 50/50.

## Handoff-list disposition (the four items from part 2)

1. **#154 merged** — done before this segment started.
2. **#152 emulator retest** — done at the tail of the prior session: with the
   fixed APK the live fetch connects and hangs the full 20s at the tarpit, the
   Edit affordance renders, and "Saved to vault" lands after. **#152 and #153
   both closed.**
3. **Pixel vault cleanup — DONE.** Deleted from `/sdcard/Documents/carnet/`:
   all 10 staged `Ideas/*.md` test notes, `Photos/{lodz-dvorak-cafe.jpg,
   photo-1786931242438.jpg}`, and `/sdcard/Pictures/Łódź Dvořák café.jpg`.
   Kept `Photos/pxl-*.jpg` (user's). `.stversions` holds copies if any call
   was wrong.
4. **Pixel APK update — BLOCKED on hardware.** The #154 release APK was
   downloaded from main's CI run, cert verified against the pinned
   fingerprint (`e5f5ed37e0…`), and `usesCleartextTraffic=true` confirmed in
   its manifest via aapt2 — but the Pixel dropped off USB (5th time) seconds
   before install and did not return within an hour of watching. **First task
   when it's replugged:** `adb install -r` the `carnet-release-apk` artifact
   from any recent main run (14-day retention; re-verify the cert), then
   re-verify Relais/local-provider reachability and recheck #152's residual
   live-path anomaly there (see part 2 §3 — the Pixel's live-vs-drain
   asymmetry was never fully explained by cleartext).

## Shipped this segment

- **#157 merged (closes #129)** — card scanner: (a) probe-only credential
  check in `probeVisionReadiness` (blank key + non-local URL per
  `netAllowlist` ⇒ preflight banner; `assertVisionReady`/`ocrCardViaVision`
  deliberately untouched so genuinely keyless remote endpoints keep working);
  (b) new `insecureTransport` flag on `HttpError`/`LlmClientError` thrown by
  `assertHttpsOrLocal`, classified as configuration by
  `classifyCardScanOcrError` — deliberately NOT the `notConfigured` flag,
  which also gates `shouldRetryWithFallback`; fallback for an insecure
  primary is preserved and regression-pinned. Adversarial review approved;
  its two actionable findings were applied pre-PR (hedged banner copy for
  keyless-but-private https endpoints like tailnet/`.local`/`[::1]`, dropped
  one vacuous test).
- **#158 merged (closes #156)** — the same flag extended to the remaining
  surfaces: `captureErrorDecision` (person/journal/preview-idea paths no
  longer enqueue doomed retries), `ideaSaveFirst` (degraded banner instead of
  queueing; raw note still saves), `queue` (drain breaks without burning
  attempts, rows survive for a post-Settings-fix drain), `personInPlace`
  (annotated consistency-hardening — its caller discards `transient`).
  **The two-pass review earned its keep here:** pass 1 caught that shipping
  the drain break without the `captureErrorDecision` half would have let
  CaptureScreen enqueue rows the drain could never clear (net-new
  head-of-line stall); fixed in a second commit, delta re-verified.
- **#156 filed then closed same-day** — the review findings from #157 that
  were out of #129's scope, spec'd with exact line refs.

## Verification pattern worth repeating

Both executors ran **negative controls** (stash the source fix, assert
exactly the new tests fail, restore) and both reviewers re-ran them
independently rather than trusting the report. Every new test in #157/#158
is a proven regression guard, not a tautology.

## Open issues audit (why nothing else was started)

- **#85** (backend switch UX + offline capture E2E): its deps #83/#84 are
  closed, but the provider-list rework (#120/#121) may have superseded the
  "backend switch" framing — needs a product call on whether to re-spec or
  close, and its acceptance run needs the Pixel in airplane mode (offline
  twice over). Don't start it as written without that call.
- **#78 / #75** (on-device LLM story/epic): per project memory the planned
  standalone local-LLM backend targets Relais on the Pixel — also
  hardware-gated and direction-gated.

## Standing constraints (unchanged)

No SQLite; no .env; frontmatter byte-compat; squash-merge; three-rule ESLint;
attribution disabled in commits; `com.ventouxlabs.carnet`; local Gradle builds
fail on Maven fetch timeouts — use CI's `apk` artifact.
