# Session handoff — 2026-08-05 (mdcrm deslop + SAF fixes shipped, scanner preflight open)

## State at handoff

Two PRs **merged to `main`**, one **open and green**. `main` is at `6577950`, CI
green on both merges.

| Suite | Count |
|---|---|
| `@carnet/mobile` | 97 files / **1574** (on `#128`; `main` is 1563) |
| `@carnet/mdcrm` | 10 files / **45** |
| `@carnet/shared` | 1 file / **12** (was **zero** — see below) |
| `verify:capture-flow` | 272 |

- **PR #126** → `1b0b0bc` — the `apps/mdcrm` workspace, its deslop pass, both SAF
  fixes, four mdcrm concurrency/correctness fixes, plan archival.
- **PR #127** → `6577950` — SAF `findSubdir` read-path fix, first tests for
  `@carnet/shared`.
- **PR #128** — OPEN, all checks green (`gate` + `apk` pass). Card-scanner
  preflight banner. **Not device-verified.**
- **Issue #129** — OPEN, follow-ups from the adversarial review of #128.

Working branch `feat/scanner-preflight-provider-hint` is clean and pushed.

## Shipped this session

### `apps/mdcrm` landed, then was cleaned and gated (#126)

The workspace arrived in `38ca1c6` as a single unpushed commit on local `main`:
89 files, +3812, **zero CI coverage** (no job existed, nothing in `gate.needs`),
and 25 tests against ~2.4k lines. The deslop pass:

- **Dead code**: 4 imports dead on arrival (`AnyRecord`, `sanitizeFilename`,
  `readFile`, `open`) plus a redundant path-escape clause.
  `noUnusedLocals`/`noUnusedParameters` now enabled so the class cannot recur.
- **Duplication**: `requiredHash`/`requireHash` → one `requireContentHash`;
  `titleFromBody`/`title` → one `firstHeading`; deleted a private clone of the
  public `listRecordPaths`.
- **Fragility**: auto-match branched on *substring-matching human-readable
  evidence text* (`entry.includes("exact normalized email")`). Rewording display
  copy would have silently stopped auto-matching. Replaced with typed
  `MatchReason[]` codes.
- **Exit codes**: dispatched on `message.includes("valid")`, which matched
  *"invalid"* in unrelated errors while missing real schema rejections (whose
  message contains no "valid" at all, so they exited `1` instead of `3`). Now
  typed via `exitCodeForError`.
- **Mutation**: `capturePipeline` mutated job records in place — and when a prior
  job existed, `job` *aliased* the stored record the caller still held. The
  regression test freezes parsed jobs and failed RED with
  `TypeError: Cannot assign to read only property 'state'`.
- **CI**: new `mdcrm` job (typecheck + vitest) added to `gate.needs`.

Four Codex-found P2s also fixed: ambiguous exact-identifier auto-match (two
contacts sharing an email silently linked to whichever id sorted first), stale
index after conflict rollback, lease-expiry TOCTOU, and a repository
check-then-write race.

**Note on the last two** — three of the four were the same shape: read state,
await, act on the stale read. For the repository race, moving the hash check
*later* does **not** help; both writers still read before either renames. Only
serializing check+commit per destination (`serializeByPath`) closes it. That
closes the **in-process** race only; two processes still rely on the lease, and
across hosts Syncthing conflict files remain the backstop.

### SAF nested directories — two bugs, one device-only (#126, #127)

`safFs.findOrCreateSubdir` passed a whole nested path (`"attachments/originals"`)
to `StorageAccessFramework.makeDirectoryAsync`, which takes a **display name** and
creates exactly one node. The `file://` sibling gets `intermediates: true` free,
which is why this went unnoticed until `mdcrmCapturePackage` became the first
caller ever to pass two segments. Fixed by walking segments; the
folder-duplication dedupe from `b230040` is preserved per segment. `findSubdir`
had the identical read-side flaw and was fixed in #127.

**The test that should have caught it passed.** The SAF mock stored into a *flat*
`Map`, so `"a/b"` was a legal single key. The mock is now strict —
`assertSafDisplayName` throws on any name containing `/`. **Do not loosen it**;
that guard is what makes the SAF branch visible.

**Then the device found a second bug the mock could have caught but no test
exercised.** `writeTextFile` hardcoded `text/plain`, and SAF appends the canonical
extension for the MIME it is handed, so the capture record landed as
`cap_X.md.txt`. mdcrm discovery is `*.md`-only, so **every capture record would
have been invisible to the server pipeline** — the feature shipping as a silent
no-op on the only storage backend this app uses. Fixed by deriving the MIME from
the filename.

Verified on-device (Pixel 9 Pro Fold, Android 17, SAF vault at
`/sdcard/Documents/carnet`) with a clean A/B:

```
21:02 pre-fix   captures/cap_…WW694WRHEHFXBTTG.md.txt
21:09 post-fix  captures/cap_…P35R5GP6N76X7SHK.md
```

`attachments/` and `processing/` both showed link count 3 (a directory containing
a subdirectory), confirming genuine nesting. Test artifacts were removed from the
vault afterward.

### `@carnet/shared` had zero tests (#127)

`npm -w @carnet/shared test` is a documented gate in `CLAUDE.md` and in the CI
`shared` job, but it exited **0 on "No test files found."** Gate-covered on paper,
untested in fact. Now 12 tests.

**Read `deriveTitle`'s docstring before touching it.** Writing those tests
surfaced what looked like a bug — it returns `""` for empty input, making its
`?? "Untitled"` fallback unreachable, and its docstring claimed "first non-empty
line" while the code took line 0 unconditionally. Changing it to match the
docstring broke three existing tests, and the callers explain why:

```
karakeepNoteExport.ts:71     deriveTitle(noteBody).trim() || stem
notificationQuickIdea.ts:92  deriveTitle(ctx.text) || "Idea"
```

The empty string is **load-bearing** — callers chain a better fallback off the
falsy value. Anything truthy steals it and every untitled note reads "Untitled"
instead of its filename stem. The docstring was wrong, not the code. Behavior
reverted, docstring corrected, contract pinned by a test.

## Open — PR #128 (card-scanner preflight banner)

Warns that the vision provider is unconfigured **when the scanner opens**, instead
of only after the photo. Non-blocking: camera appears immediately, Capture stays
enabled, because save-first writes the image before OCR is attempted.

Three design traps, each found during planning and each a silent failure:

1. **Wrong provider.** The deleted PR #29 guard read
   `resolveActiveProvider(...).baseUrl`. OCR resolves through
   `resolveVisionProviderId(settings)`, which consults `visionProviderId` first.
   Restoring that guard would warn on *correctly configured* setups.
2. **Invisible hint.** `CaptureModeInput`'s `HelperText` renders *behind* the
   modal. A hint set in `open()` is only visible after the scanner closes.
3. **Fallback chain.** Probing primary *and* fallback would under-warn:
   `shouldRetryWithFallback` returns `false` for `isNotConfiguredError`
   (`dispatcher.ts:158`), so an unconfigured primary never falls back anyway.

Zero duplication is structural: `assertVisionReady()` is extracted from
`ocrCardViaVision` and both the real call and the probe use it. A test pins the
assert **order**, since the extraction could otherwise silently change which
message a user sees.

### `/codex review` found nothing; `/codex challenge` found two real bugs

Same model, same diff. The review returned a one-line summary and zero findings;
the adversarial pass found two, both verified against source. **A clean review is
weak evidence of correctness.**

One was fixed here (`245eba0`): an insecure remote URL classified as `transient`,
so the banner stayed silent while the post-capture path said "scan again" — the
exact wrong-retry-advice class the feature exists to remove, reproduced inside the
fix. Every probe failure is now treated as configuration, because the probe makes
no network call so `transient` is impossible there by construction.

**Do not "fix" this at the throw.** Adding `{ notConfigured: true }` to
`assertHttpsOrLocal` looks like a one-liner (I claimed it was, and was wrong) but
it has three call sites, and `shouldRetryWithFallback` returns `false` for
not-configured errors. It would silently disable the fallback chain for every
misconfigured primary. Today an insecure primary correctly falls back.

## Outstanding

1. **Device-verify + merge #128.** All checks green. The banner has never been
   seen on a device — unit-tested only. Given the `.md.txt` bug above, where a
   fully green suite plus a passing review hid a feature that did nothing, this is
   worth the 60 seconds: clear the vision model, open the scanner, confirm the
   banner shows *before* framing and that Capture still lands the image.
   `docs/smoke-test.md` → "Capture — Person (without the gateway)".
2. **Issue #129** — keyless cloud providers report ready (needs a provider-aware
   credential concept; `relais` is loopback and legitimately keyless), and the
   post-capture wording for insecure URLs (pre-existing on `main`, entangled with
   the fallback tradeoff above).
3. **`main` has NO branch protection.** `GET /branches/main/protection` returns
   **404**. `CLAUDE.md` states `gate` is "required by branch protection" — it is
   not, and #126 merged with `mobile-android` still pending as a result. Either
   enable it or fix the doc; right now the doc is actively misleading.
   ```
   gh api -X PUT repos/Entrevoix/carnet/branches/main/protection \
     -F required_status_checks.strict=true \
     -f 'required_status_checks.contexts[]=gate' \
     -F enforce_admins=true \
     -F required_pull_request_reviews=null -F restrictions=null
   ```
4. **On merge of #128**: `scanner-preflight-provider-hint.plan.md` →
   `Status: shipped`, move to `plans/completed/`.
5. **Release tag** not cut. `main` CI is green, so `v0.3.0` is unblocked.
6. **Device** is on a locally-built branch APK, not a `main` build.

## Traps for the next session

- **Squash-merge orphans local `main`.** If local `main` holds unpushed commits,
  `git pull --ff-only` fails after the squash. Treat that failure as a STOP, not a
  warning — I stepped past it once and nearly committed an entire PR's worth of
  work onto the pre-merge tree, which would have silently reverted #126. Recover
  with `git fetch && git reset --hard origin/main`, but first prove nothing is lost
  (`git diff origin/main <merged-branch>` empty = identical trees), then grep the
  new base for a symbol the merged PR introduced before writing any code.
- **A mock more permissive than the real API turns a test into a rubber stamp.**
  The SAF flat-`Map` mock is the canonical example here.
- **A documented contract disagreeing with code is not automatically the code's
  fault.** `deriveTitle` is the canonical example.
