# Session handoff — 2026-08-18 (decomposition wave, v0.6.0, #85 acceptance in flight)

Follows `2026-08-17-insecure-transport-classification-and-pixel-status.md`.

## State at handoff

`main` at **`a636ade`** (#177), CI green. Mobile suite **1999/1999** (baseline
1873 at session start — every addition negative-control verified). Release
**v0.6.0 published** (tag → release.yml → signed `carnet-v0.6.0.apk`, cert
verified). No open PRs. Open issues: #85, #78, #75 (one device run from
closing — see below), #175 (fixes merged, verification pending), #176 (design
work, both repos), #172 closed by #173.

## Shipped this session (15 PRs, #160–#174, #177)

- **Decomposition wave with adversarial review** (critic + code-reviewer per
  branch, byte-level move-only audits, export-parity via the TS checker):
  `writer.ts` → writerMarkdown/pairedBinaries/mimeTypes/noteNaming (#160),
  `llmClient.ts` → llmErrors/llmGuards/llmHttp + guardedFetch dedup (#162),
  CaptureScreen extraction (#163), RecentDetailScreen extraction (#164),
  LlmProviderSection → ProviderEditForm + llmProviderPicker (#166),
  VoiceButton → recognizerCatalog/sttDeviceProbe/VoiceErrorSheet/
  VoiceRecognizerPicker (#168) behind a 14-test oracle built first (#167 —
  the oracle audit caught a vacuous recording-cap test before it mattered).
  Test-suite splits along the same seams (#160, #169). Over-800 set is now:
  VoiceButton ~1172, CaptureScreen ~990, RecentDetailScreen ~809 — each at a
  documented, reviewed floor (see CLAUDE.md's block).
- **#165** — busy-latch bug class fixed (six RecentDetail handlers get
  try/finally + negative-controlled regression tests).
- **#170** — queue.test.ts ciphertext flake fixed (collision-proof sentinel).
- **#171 (issue #85 UX half)** — local-provider readiness hints, mount-probed,
  warn-not-block.
- **#173 (closes #172)** — pre-vault capture migration on vault-folder pick:
  byte-identical copy, readback-verified delete (guard is test-pinned after
  the audit found it uncovered), Recents remap, retry-on-every-save.
- **#177 (issue #175 fixes)** — ~10 user-facing "OmniRoute" hardcodes now name
  the active provider's real label (dispatcher labels reconciled to
  `provider.label`); **automatic queue drain on app foreground** via
  `lib/foregroundDrainTrigger.ts` (previously the "finishes automatically"
  copy was false — nothing triggered a drain).
- **v0.6.0 released** (#174 bump, versionCode 4).

## Device QA (Pixel 9 "comet" + fresh Pixel 7 "cheetah")

- Hardware STT smoke of the VoiceButton decomposition: **PASS** (real SODA
  recognizer; cheetah's run also hit the NO_SPEECH path cleanly). The old
  release-gate memory item is discharged. STT model-download prompt remains
  unreproducible — both Pixels already have the en model.
- #85 airplane-mode arms: offline Idea+Journal capture/queueing and the #171
  hint all **PASS**. Discriminating experiment: **loopback fetch works under
  full airplane mode** (nc AND Carnet's Test Connection succeed with zero
  networks up) — the on-device-server premise is sound.
- The original acceptance failure (enrichment queued despite live loopback
  Relais) was traced to the misleading hardcoded copy (#177 fixes) plus an
  unexplained app-layer rejection — unauthenticated Relais returns 401;
  suspect auth/model mismatch at capture time. **The re-run on the fixed
  build is the one open device task** (build already installed on comet;
  Relais staged; comet dropped off USB at the Test Connection step — 6th
  drop).
- Incidents, both disclosed and resolved: a screenshot-scaling tap bug caused
  a ~15s misdialed real phone call (root-caused; uiautomator-bounds-only
  discipline enforced since — memory file updated); a reviewer agent's
  stash-pop restored the ancient `stash@{0}` mid-session (recovered; stash
  intact and still in the list, owner's call to drop).
- QA vault entries cleaned (comet idea note archived; the QA journal line
  never landed in the day file — only the user's real Zurich entry exists;
  cheetah QA note archived). One anomaly parked: after the upgrade install,
  the already-enriched old QA note showed `pending` again on comet — check
  whether Recents/queue-row state desynced (2-minute look when comet is back).

## Decisions taken (user-confirmed)

- #85 re-specced onto the provider-list architecture (dedicated backend
  toggle is dead; provider list IS the switch).
- **B2 dropped** — close #75 when #78 closes; dedicated-OCR only returns if
  quality pain resurfaces (desktop-fate pattern).
- TLS: never disable verification for Relais's self-signed cert — #176 holds
  the pairing-flow design options.

## Next session, in order

1. **Comet replug → finish the #85 acceptance re-run** (steps staged in this
   session's agent transcript: Test Connection → airplane capture → exact
   message text now names the real provider). Pass ⇒ close **#85 → #78 →
   #75** (B2 dropped) and #175 if the true rejection cause is confirmed fixed
   or reclassified.
2. Check the reappeared-`pending` badge anomaly on the old comet QA note.
3. #176 (Relais cert pairing) — needs product direction; spans both repos.
4. Consider **v0.6.1** once #85's acceptance passes (today's #173/#177 fixes
   are unreleased; v0.6.0 shipped hours before them).
