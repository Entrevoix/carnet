# Session handoff — 2026-08-18 part 2 (Stage-2 epic closed, v0.7.0, F-Droid prep)

Continuation of `2026-08-18-decomposition-wave-v0.6.0-and-85-acceptance.md` — its
"Next session, in order" list is fully discharged.

## State at handoff

`main` at **`8f39785`** (#184), CI green. Mobile suite **2004/2004**. Releases
**v0.6.0 AND v0.7.0** both published today (signed APKs, cert-verified).
**Issues #85, #78, #75 CLOSED** — the Stage-2 epic is complete, with hardware
evidence. #175 closed (root-caused + fixed). Open: #176 (Relais TLS pairing
design), #182 (F-Droid, only user-action steps left).

## The #85 acceptance saga (worth reading — three bugs found by one test)

The offline acceptance run failed twice before passing, each failure real:
1. First run (comet): capture queued despite a live loopback Relais, message
   blamed "OmniRoute". Tracer disproved the scary stale-provider theory —
   found hardcoded "OmniRoute" copy in ~10 surfaces + NO automatic queue drain
   (the "finishes automatically" promise was false). Both fixed in **#177**.
2. Discriminating experiment: loopback fetch (nc AND the app's own Test
   Connection) works under FULL airplane mode — RN/OkHttp is not
   network-gated. The on-device-server premise is sound.
3. Second run (rango, Pixel 10): #177 messaging confirmed live; failure now
   precisely visible — the 20s enrichment timeout killed cold CPU-fallback
   inference mid-generation (Relais logged Broken pipe ~30s into decode).
   Fixed in **#180**: local (loopback/RFC1918) providers get the 120s tier.
4. Final run: PASS — full airplane mode, on-device Gemma E2B enrichment
   completed in ~25s, title/tags/summary/Related all generated.

Audit note on #180: Tailscale 100.64/10, IPv6 loopback, and mDNS hostnames
still classify remote (short timeout) — deliberate; widening isLocalNetworkUrl
also widens isCredentialSafeUrl, so it belongs to #176's security-reviewed
design.

## Also shipped this half

- **#173** pre-vault capture migration (readback-verified deletes, audit-pinned).
- **#181** v0.7.0 bump; release verified (carnet-v0.7.0.apk, 116,926,099 bytes).
- **#183** F-Droid prep: fastlane metadata (en-US, changelogs for
  versionCodes 3-5), dead expo-sqlite dependency removed (stub/alias cleaned,
  CLAUDE.md hard-constraint updated to "removed — do not re-add").
- **#184** docs/fdroid/: ready-to-paste IzzyOnDroid submission +
  fdroiddata recipe draft (unsubmitted, open questions annotated).
- Issue #182 tracks the F-Droid effort; audit verdict: no fundamental blocker;
  the "stale build.gradle" finding was a false positive (android/ is
  gitignored; recipes regenerate it via prebuild --clean).

## Device notes

- rango (Pixel 10, 57211FDCG0023C) is a real configured device: Carnet was
  v0.4.0 there, upgraded to current today; Relais installed with Gemma E2B
  now RESIDENT (2.6GB download happened during QA — flagged to user). Its
  Carnet has no vault folder linked (captures land in internal storage — the
  #173 migration will move them when one is picked).
- comet (Pixel 9) dropped off USB mid-run (6th time) and did not return; its
  QA vault entries were cleaned earlier (idea archived; the QA journal line
  never actually landed in the day file). One parked anomaly: the old
  enriched QA note briefly showed `pending` again after an upgrade install —
  possible Recents/queue-row desync, 2-minute look next time comet is up.
- cheetah (Pixel 7): fresh install QA'd and cleaned; nothing pending.

## Next session

1. User-gated: IzzyOnDroid submission (paste docs/fdroid/izzyondroid-submission.md),
   #176 design call, #182 Phase-2 fdroiddata MR.
2. Fastlane screenshots: emulator capture was in progress at handoff — if
   `fastlane/metadata/.../phoneScreenshots/` exists uncommitted, review and PR.
3. comet: pending-badge anomaly check when replugged.
