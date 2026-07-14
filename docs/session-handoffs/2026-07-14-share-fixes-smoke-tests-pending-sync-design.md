# Session handoff — 2026-07-14 (share-intent fixes, on-device smoke results, paired-binary fix; pending-sync queue DESIGNED not built)

## State at handoff

Continuation of `2026-07-12-voice-extraction-ux-fixes-release-migration.md`. Device runs the
release build (rebuilt twice today — currently carries all patches below). Commits, oldest
first, all pushed; CI green through `938599f`, `9171376` pushed at handoff time (watch it):

- `cf88bf8` — **expo-share-intent crash patch** (`patches/expo-share-intent+5.1.1.patch`,
  the repo's second patch-package patch; CLAUDE.md updated). Upstream `getFileInfo` hard-
  crashed the app ("Carnet keeps stopping" loop) on any share with an unreadable content
  URI: unguarded `query(...)!!` → SecurityException, empty cursor → CursorIndexOutOfBounds,
  both in OnNewIntent on the main thread. Patch makes metadata best-effort; missing MIME
  defaults to `application/octet-stream` (review catch: the library's own JS parser calls
  `mimeType.startsWith` unguarded — a null would throw there and silently DROP the share).
  Verified: both formerly-fatal synthetic shares leave the pid untouched; real DocumentsUI
  share works end-to-end.
- `938599f` — **stream-backed text/plain shares route to the file path** (same patch file).
  File managers share a .txt as SEND + text/plain with the file in EXTRA_STREAM and no
  EXTRA_TEXT; upstream's text branch read only EXTRA_TEXT → `{text:null}` → silent drop
  (observed via DocumentsUI). Genuine text/url shares unchanged. Verified on-device.
- `9171376` — **paired-binary links survive SAF's create-time rename** (writer.ts).
  SAF `createFileAsync` appends the mime-canonical extension when the display name lacks
  it; `writeBinary` returned the pre-rename name, the note linked it, pairing silently
  broke → attachments silently skipped on Karakeep export, orphaned on archive-delete.
  Fix: finalName derived from the URI SAF actually created + `extFromMime`/
  `mimeFromFilename` learn docx/xlsx/pptx/doc/xls/txt/md/csv/zip/json. 3 new tests;
  suite now **955/955**.

## On-device smoke results (release build, fresh install, user-configured)

- **Dark-mode caret/selection (202d8f8): verified** — teal caret, teal handles, translucent
  selection.
- **STT first-tap bug: did NOT reproduce** on the one condition that ever triggered it
  (fresh install, first tap, permission dialog granted mid-flow). Consider it gone until
  seen again.
- **Silence auto-stop: first on-device verification** — no-speech session self-stopped at
  ~20s (2 windows), matching spec.
- Soft anomaly (noted, not investigated): a stop-tap landing during Soda's
  `blockingReconnect` window can be silently dropped natively; the silence auto-stop
  backstops it ~10s later. Watch for a lingering mic pill after stop taps.
- **Karakeep export over Tailscale: works** (bookmark create, tags, id stamping,
  update-in-place all verified live; "unreachable — timed out after 20s" surfaced
  correctly while the tunnel was down).
- **CAVEAT that re-opens one question:** both attachment-upload "successes" today
  (docx, txt) predate the `9171376` pairing fix — broken links skip silently, so those
  exports may have uploaded NO attachment at all. "This Karakeep accepts docx/txt" is
  therefore UNPROVEN. **Next session: re-run one file share → Karakeep export on the
  current build** (pairing now correct) and see whether the upload succeeds or the
  unsupported-type skip snackbar fires ("…is a file type Karakeep doesn't accept — kept
  in the vault only"). Both outcomes are handled; we just don't know which one this
  server produces. The user's original 2026-07-12 report was a .txt → HTTP 400.
- Device/vault state: test notes+files fully cleaned (app UI delete + shell sweep);
  **two stale test bookmarks remain in the user's Karakeep** ("Shared file:
  agenda-test.docx", "Shared file: planning-notes.txt") — manual delete, tailnet-only.
  Karakeep URL is a Tailscale hostname; 192.168.1.20:3000 is GITEA, not Karakeep (a
  false lead this session — don't repeat it).

## NOT BUILT — pending-sync queue (user-requested, designed, ready to implement)

User ask: "when a host is unreachable it queues for a connection check (vpn, tailscale)".
Design settled this session; next session implements:

1. `lib/pendingSync.ts` — AsyncStorage list (`carnet:pendingsync:v1`) of
   `{id, kind:'karakeep-export', filepath, entryTitle, queuedAt, attempts, lastError}`.
   Dedupe by filepath. `shouldQueueForConnectivity(err)`: duck-typed `{status}===0`
   (network/timeout ONLY — 4xx/5xx are real answers, never queued). Drain orchestration
   with INJECTED deps (`isReachable`, `exportOne`) so it's unit-testable: stop the drain
   on first unreachable result; drop item when the note no longer exists; keep item on
   other errors (cap ~10 attempts, then drop).
2. `lib/hostReachability.ts` — `isHostReachable(baseUrl, ~4s timeout)`: fetch with
   AbortController; ANY http response (401/404 included) = reachable, abort/network
   error = down. This is what makes it VPN/Tailscale-aware without NetInfo (wifi looks
   "connected" while a tailnet host is unreachable).
3. Wiring: `exportNoteToKarakeep`'s `failed` outcome gains `unreachable: boolean`
   (KarakeepError.status === 0). RecentDetailScreen: unreachable failure → enqueue +
   friendly info ("queued — will send when the server is reachable; check VPN/Tailscale")
   instead of the error banner. Drain triggers: AppState→active (throttle ≥30s) mounted
   once in App.tsx, plus a HomeScreen banner "N exports waiting for Karakeep — Retry"
   (screen is `HomeScreen.tsx`, has smoke tests — keep them green).
4. Tests: pendingSync CRUD/dedupe/classifier/drain (injected deps), hostReachability
   (mock fetch), karakeepNoteExport unreachable-flag threading.
   OmniRoute enrichment already has save-first+queue semantics — do NOT rebuild that;
   this queue is Karakeep-export-scoped, generalizable later.

## Also open (unchanged)

- OmniRoute dashboard: Mistral provider key unused since B2 — delete candidate.
- Backlog: self-hosted Sentry, minimal ESLint (scope discussion first), desktop fate.
- `.omc/skills/` has local (untracked) device-ops + RKStorage-surgery skills; auto-memory
  documents the release-build constraints (no run-as, no Metro, `adb install -r` upgrades).
