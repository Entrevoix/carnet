# Session handoff — 2026-08-17 (part 2: cleartext root cause, #144 verified, PR #154 in flight)

Continuation of `2026-08-17-eight-prs-merged-device-validation-model-browser-fix.md` —
that doc's "Still open" list drove this segment.

## State at handoff

`main` at **`bcfa1bb`** (#151). **One open PR: #154** (cleartext fix — see below),
CI in flight at handoff time; `gate` was expected green, and the `apk` artifact
from its run is the input to the next session's first task. Suites at last
verified state: mobile 1853/1853, mdcrm 50/50 (20 consecutive clean runs).

Devices: the **Pixel dropped off USB mid-session (4th time) and did not return**
— the vault cleanup is staged but unexecuted (list below). An **API 35 x86_64
emulator** (`emulator-5554`) is running with the release APK of `a517e06`
installed, provider restored to `https://llm.grepon.cc`, queue drained, no
tarpit/reverse left behind.

## Shipped this segment

- **#150 merged** — `countDuplicateIds` + one-shot catalog-duplicate warning at
  the fetch site (closes #148's recorded deferral). Devils-advocate pass:
  confirmed `console.warn` survives release (no babel stripping) and the
  wiring test's once-per-fetch assertion is prefix-filtered and spy-restored.
- **#151 merged** — mdcrm flake root cause: `initialize()` re-entered from
  every processor entry point (5×/run → 50 fsync+rename into `schemas/`), and
  a vitest timeout's uncancelled remainder raced `afterEach rm` → the
  `ENOTEMPTY`. Fix: per-instance memoized init promise (rejection not cached);
  20s workspace timeout as documented headroom. Devils-advocate: no blocking
  findings (memo rejection semantics traced clean).
- **Issues #152 → #153 filed**, then **PR #154 opened** (the arc below).

## The cleartext arc — read this before touching #152/#153/#154

1. **#142's Edit affordance was unobservable on the Pixel** (3 controlled
   attempts incl. fresh state + verified-empty queue): capture hits the
   saved/queued outcome in <1.5s even against a tarpit that accepts-and-hangs.
   Filed as **#152**.
2. Emulator investigation (user-provided emulator; Maestro-driven): live
   enrichment **never connects at all** — extracted the real error via the
   Finish-enrichment banner: `OmniRoute network error — Network request
   failed`. `aapt2` on the release APK: **no `usesCleartextTraffic`, no
   `networkSecurityConfig`** → platform default blocks cleartext. Filed
   **#153**; commented the root cause onto #152.
3. **Then the twist**: a comment in `LlmProviderSection.tsx` records a
   2026-08-01 device verification that release builds DO permit loopback
   cleartext on the Pixel — which my own tarpit data corroborates (the queue
   drain's plaintext POSTs landed). Same APK, opposite behavior on API 35.
   **The platform default is version/device-dependent.** This strengthens
   #153 (an explicit attribute is the only deterministic option) and means
   #152 on the *Pixel* is NOT fully explained by cleartext — its live path
   failed instantly even where loopback cleartext worked. The live-vs-drain
   asymmetry there is still unexplained; do not close #152 on the cleartext
   story alone.
4. **PR #154**: `withCleartextLocalProviders` config plugin pins
   `usesCleartextTraffic="true"` on `<application>`. **Deliberate deviation
   from #153's original fix direction, flagged for review**: an NSC mirroring
   `netAllowlist.ts` is not expressible (NSC matches domains, not the RFC1918
   CIDR ranges the allowlist promises), so loopback-only NSC would keep LAN
   Ollama broken. Global attribute + JS `isCredentialSafeUrl` as the
   credential guard = exactly how every debug build has always run. Includes
   `verify-cleartext-prebuild.sh` (verified RED against unregistered plugin,
   then GREEN) and the Settings help-text truth update (the copy has now
   flip-flopped twice with evidence; its comment carries the full history —
   keep text/netAllowlist/plugin in sync).

## On-device validation closed this segment

- **#144 fully verified on the Pixel**: Library pick of a Unicode-named file →
  `Photos/lodz-dvorak-cafe.jpg` (also proves #145's fold on-device), embed
  appended, frontmatter byte-identical, renders inline; camera shutter →
  `photo-<ts>.jpg` appended after the existing attachment; permission gate
  keeps Library usable. Dismiss-race not hand-drivable (sub-second) — rests on
  its 3 regression tests.
- Offline queue verified incidentally: instant-fail enqueue, "Retry now"
  (tap the sync icon on Home to open the sheet), full drain on recovery.
- The bake-off pick (`gemini/gemini-flash-lite-latest`) verified live:
  capture→enrich→rewrite loop works end-to-end through llm.grepon.cc.

## Next session, in order

1. **Merge #154** once `gate` passes (`apk` is advisory but WAIT for it —
   its artifact is needed): `gh pr merge 154 --squash --delete-branch`.
2. **#152 retest on the emulator with the fixed APK**: download the artifact
   (`gh run download <run-id> -n carnet-release-apk`), verify cert
   (`e5f5ed37e0…`), `adb install -r` on emulator-5554. Re-run the tarpit
   repro — scratchpad had `152-setup.yaml` / `152-repro.yaml` Maestro flows +
   tarpit script + `ui.sh`/`find_exact.py` helpers (session-scoped; cheap to
   recreate from the handoff + issue text if gone). With cleartext fixed, the
   live fetch should now connect and hang 20s → the Edit affordance is finally
   observable. If Edit appears and works: close #152 with the note that the
   Pixel's residual live-path anomaly should be rechecked after the Pixel gets
   this APK. If it does NOT appear: the CaptureScreen phase logic is the bug —
   fix there (Edit renders only in `phase === "submitting"`,
   `CaptureScreen.tsx` ~line 999).
3. **Pixel vault cleanup** (when it's back on USB) — delete from
   `/sdcard/Documents/carnet/`: Ideas/{edit-window-test-original,
   tc142-original-draft-text, tc142b…g (6), test,
   vault-redirect-verification-notesaf-vault-write-check}.md,
   Photos/{lodz-dvorak-cafe.jpg, photo-1786931242438.jpg}, plus
   `/sdcard/Pictures/Łódź Dvořák café.jpg`. Keep `Photos/pxl-*.jpg` (user's).
   `test.md` is included by content-judgment (self-describes as a system-test
   placeholder); `.stversions` has a copy if that call was wrong. Emulator
   also has 2 sandbox QA notes (hermes.md, shared-text-…) — invisible,
   harmless, ignore.
4. **Update the Pixel** to the #154 APK (release→release upgrades in place
   now) and re-verify Relais/local-provider reachability there.

## Operational learnings (this segment)

- **Maestro on this app**: `hideKeyboard` can be a no-op (ADB-typed input may
  show no IME) and a compensating `back` EXITS the screen — swipe in the top
  half (50%,40%→50%,10%) instead, no dismissal needed. `scrollUntilVisible`
  at default 100% visibility misses the "Save provider" button; fixed swipes
  + `runFlow when visible` second-chance is sturdier. Setup flow should end
  with a persistence assertion (reopen Settings, assertVisible the value) —
  unsaved edit buffers are silently lost on screen exit.
- **Substring UI matching bites**: "Edit" matches "your **edit**or" in help
  text — exact-match on node text/content-desc for buttons.
- **Tarpit + adb reverse** is the right harness for hang-testing, but only
  proves what it proves: with cleartext blocked the fetch never reaches it,
  which looks identical to "app decided not to call". Pair it with a
  device-shell `nc` probe (proves the route) and `aapt2 dump xmltree` (proves
  policy) before believing either direction.
- Don't `pkill -f <word>` where `<word>` appears in your own shell's command
  line — it self-kills (exit 144).
- The app's error strings are extractable without a debug build via the
  Re-enrich/Finish-enrichment banner on a saved note.
- Emulator loopback: `adb reverse` works the same as on-device; `10.0.2.2`
  untested and unnecessary.

## Standing constraints (unchanged)

No SQLite; no .env; frontmatter byte-compat; squash-merge; three-rule ESLint;
attribution disabled in commits; `com.ventouxlabs.carnet`; local Gradle builds
fail on Maven fetch timeouts — use CI's `apk` artifact.
