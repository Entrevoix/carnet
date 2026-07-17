# Session handoff — 2026-07-16 (pending-sync queue BUILT + device-verified; share contentUri fix; Karakeep-.txt question CLOSED)

## State at handoff

Continuation of `2026-07-14-share-fixes-smoke-tests-pending-sync-design.md`. All three
commits pushed to `main`, **CI fully green on all three** (including the advisory `apk` job):

- `7afb14c` — **pending-sync queue for Karakeep exports** (the item the previous handoff
  designed; built to that design with two review-driven refinements, below).
  - `lib/pendingSync.ts`: AsyncStorage queue (`carnet:pendingsync:v1`) of
    `{filepath, entryTitle}` pointers, deduped by filepath; drain orchestration with
    INJECTED deps (`isReachable`, `exportOne`) — stop on unreachable without burning
    attempts, drop confirmed-gone notes, cap real errors at 10 attempts then drop.
    Same withLock / single-flight patterns as `lib/queue.ts` (deliberately: reader who
    knows one knows the other). This queue holds POINTERS to notes already on disk;
    `lib/queue.ts` holds raw captures — do not merge them.
  - `lib/hostReachability.ts`: 4s HEAD probe, ANY http response (401/404/405) =
    reachable. This is the VPN/Tailscale-awareness — never NetInfo.
  - `lib/pendingSyncRunner.ts`: real bindings; re-reads the note body at drain time.
  - `exportNoteToKarakeep` failed outcome carries `unreachable: boolean`
    (`KarakeepError.status === 0 && !notConfigured` at the throw site — this IS the
    classifier; a duck-typed `shouldQueueForConnectivity` was built then deleted as
    dead duplication).
  - UI: RecentDetail queues on unreachable failure (enqueue OUTSIDE the mounted guard)
    + info snackbar; Home banner "N export(s) waiting for Karakeep" with Retry;
    App.tsx drains on cold start + AppState→active, throttled 30s.
  - Review refinements vs the design: (1) a transient note-read failure burns an
    attempt instead of silently dropping the item — `gone` only when a `file://` note
    is CONFIRMED missing (`getModificationTime === null`); SAF `content://` can never
    confirm, so its read failures always retry and a deleted SAF note drops at the cap.
  - 37 new tests; suite grew 955 → 988.
- `14803fb` — docs: mid-export duplicate-bookmark window added to
  `exportNoteToKarakeep`'s ACCEPTED LIMITATIONS (create succeeded → status-0 drop
  before the karakeepId stamp → queue retries an unstamped note → one duplicate).
  Real fix if ever wanted: stamp the id right after create/update, not after the
  asset push.
- `7159514` — **share-save fix: read shared bytes via the OS-granted content:// URI.**
  Found by the on-device retest, NOT by tests: a real Files-app `.txt` share failed at
  Save with `file:///storage/emulated/0/Download/… isn't readable`. Root cause:
  expo-share-intent's JS parser resolves `path` from MediaStore's `_data` column (raw
  filesystem path, unreadable under scoped storage) and DROPS the share's `contentUri`.
  Fix: the repo's `patches/expo-share-intent+5.1.1.patch` grew a JS half (threads
  `contentUri` through the parsed `ShareIntentFile` in `build/utils.js` + `.d.ts`), and
  `shareHelpers.shareFileReadUri()` prefers `contentUri` over `path` at all three
  ShareReceive read sites (image/audio/file). Images previously worked only because
  FileProvider sources fall back to a readable cache copy — Downloads/DocumentsUI
  sources resolve to the raw path and were broken. Suite 990/990.
  **If bumping expo-share-intent, the patch now carries BOTH Kotlin and JS hunks —
  regenerate with `npx patch-package expo-share-intent --exclude 'android/build/'`.**

## On-device verification (release build installed 2026-07-14 22:54, = 7159514 tree)

Both were driven end-to-end on the Pixel via the real system share sheet (synthetic
`am start` shares do NOT get working URI grants from adb shell on this build — proven
dead end, don't retry it; use Files app → Share → Carnet).

1. **Karakeep `.txt` attachment question from the previous handoff: CLOSED — outcome
   (b), the server refuses the type.** With pairing correct and the share fix in, the
   export produced exactly: "Exported to Karakeep. karakeep-retest.txt is a file type
   Karakeep doesn't accept — kept in the vault only." Bookmark created without the
   attachment — the handled skip path, matching the user's original 2026-07-12
   `.txt → HTTP 400` report. The server genuinely rejects `.txt`; NOT a client bug.
   Also saved to auto-memory (`karakeep-txt-attachments-refused`).
   **Late-session addendum: `.docx` is ALSO refused** — same retest procedure, same
   skip snackbar ("karakeep-docx-test.docx is a file type Karakeep doesn't accept —
   kept in the vault only"), bookmark created without the attachment. The 2026-07-13
   docx "success" is conclusively explained as a pairing artifact. This server's
   accept-list is likely ~images + PDF; don't re-test client-side — changing it is a
   server-side allowlist question.
2. **Pending-sync queue: full lifecycle PASS.** Airplane mode on → export → queued
   snackbar (exact designed text, no error banner) → Home banner with Retry → offline
   Retry = fast no-op, no attempt burned → airplane off → app foregrounded →
   **auto-drain fired with no manual Retry**, `karakeepId` stamped into the note →
   banner gone on next fresh read.
   - Known LOW confirmed in the wild: an already-focused Home shows a stale banner
     count until the next focus/app-start re-reads it. Cosmetic, self-correcting.
   - Device cleanup done (vault/Archive/Download swept, airplane mode off, wifi +
     tailnet verified back up).

## New findings (small, unfixed)

- **Archive rename quirk**: archive-deleting the paired share note moved its `.md` into
  `Archive/` as `primary%3Acarnet%2FIdeas%2Fpending-sync-test.md` (SAF-URL-encoded
  document id as display name) while the paired `.txt` archived under its correct name.
  Look at `moveToArchive`'s display-name handling in `writer.ts` when convenient.
- QA-agent operational note: the qa-tester subagent stalled twice waiting on its own
  sleep timers during the pending-sync run; steps 7–9 were finished by driving adb
  directly from the main session. Fine to do that — uiautomator dump + input tap/swipe
  covered selection-mode delete without issues.

## User action needed (tailnet-only, agents can't reach Karakeep's UI)

Delete leftover test bookmarks in Karakeep: **"Shared file: karakeep-retest.txt"**,
**"Shared file: pending-sync-test.txt"**, **"Shared file: karakeep-docx-test.docx"**,
plus the two 2026-07-13 stragglers if still present ("Shared file: agenda-test.docx",
"Shared file: planning-notes.txt").

## Open / backlog (mostly unchanged)

- Duplicate-bookmark real fix (stamp karakeepId immediately after create/update) — small.
- Stale Home banner count after a background drain — cosmetic, has a clear fix
  (re-read count on an AppState listener or after App.tsx drains).
- Watch item: stop-tap during Soda's `blockingReconnect` window (lingering mic pill).
- OmniRoute dashboard: unused Mistral provider key — delete candidate.
- Backlog: self-hosted Sentry, minimal ESLint (scope discussion first), desktop fate.
