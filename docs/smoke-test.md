# Carnet — Real-device smoke test

End-to-end verification you can run with an Android phone running carnet, a
workstation hosting the OmniRoute / navetted **LLM gateway** (reachable over
HTTPS), and Syncthing pairing the capture folder with your vault. Run this
before tagging a release or after any change touching capture handlers, the
writer/frontmatter layer, the offline queue, sync, or Karakeep export.

There is **no daemon, no QR pairing, no token handshake** — all configuration is
entered in-app on the **Settings** screen. Tick boxes inline as you go; most
steps take under a minute.

**Automated coverage:** most of the logic below (frontmatter shape, slug
collision, same-day journal append, tag/vault indexing, WYSIWYG frontmatter
preservation, and fixture-driven repro of the four historical bug classes) is
already exercised headlessly — no device needed:

```
npm -w @carnet/mobile run verify:capture-flow
```

This runs `writer.test.ts`, `frontmatter.test.ts`, `queue.test.ts`,
`vault.test.ts`, `vaultSearch.test.ts`, `journalTagIndex.test.ts`,
`markdownRoundTrip.test.ts`, and `test/fixtures/repro.test.ts`. Sections below
are annotated with `(automated coverage: ...)` where this script already
checks the underlying logic; the manual steps remain necessary for anything
device-only (voice/OCR, real share-sheet, Syncthing, Karakeep network calls).

---

## Prerequisites

- [ ] Phone has carnet installed (Expo Go or a dev/release build)
- [ ] Workstation runs the OmniRoute / navetted LLM gateway, reachable from the
      phone over HTTPS (same Tailscale net or LAN)
- [ ] Syncthing pairs the device folder `/Documents/carnet/` with the workstation
      vault `~/Obsidian/Carnet/` — see [sync-setup.md](sync-setup.md)
- [ ] *(Optional)* A reachable Karakeep instance + API key, for the export tests
- [ ] *(Optional)* Workstation has the Tauri prerequisites for desktop testing

## First launch & configuration

- [ ] Fresh install (or wipe AsyncStorage): launch carnet. App boots straight to
      **Home** — there is no pairing/QR screen.
- [ ] **Settings** → set the **OmniRoute URL** + **API key**.
- [ ] *(Optional)* set the **Karakeep URL** + **API key**.
- [ ] Keys live in `expo-secure-store`, not AsyncStorage: on a dev build, inspect
      AsyncStorage — `carnet:settings:v1` holds the URLs + non-secret prefs but
      **no API-key/token field**.

## Cold-start budget

(Automated: `src/lib/startupTiming.test.ts` covers the classifier/latch;
this device check verifies the real number.)

- [ ] Force-stop the app, relaunch from the launcher, then
      `adb logcat -d | grep "\[startup\]"`. **No line containing `EXCEEDS`**
      may appear (release builds only log on a budget breach). A breach means
      a recent change regressed launch speed — capture latency is the
      product's moat; treat it like a failing test, not a note.

## Capture — Idea (golden path)

_(automated coverage: `npm run verify:capture-flow` — frontmatter shape via
`writer.test.ts`/`frontmatter.test.ts`)_

- [ ] Home → **Idea** → type a sentence ("test idea — verifying smoke flow").
- [ ] Tap **Send**. A loading state shows while the gateway enriches.
- [ ] After a few seconds a preview card renders with the markdown + filepath.
- [ ] Status chips are visible (e.g. `seedling` selected / `developing` / `mature`).
- [ ] Tap **Save** → returns Home; the capture appears at the top of **Recents**.
- [ ] On the workstation, `Ideas/<slug>.md` has valid Obsidian frontmatter
      (`created`, `status`, `tags`).

## Promote idea status

_(automated coverage: `npm run verify:capture-flow` — mtime conflict guard via
`writer.test.ts` and `test/fixtures/repro.test.ts`)_

- [ ] Repeat the idea capture; this time tap **developing** in the preview card
      before Save. The markdown re-renders.
- [ ] Reload the file: frontmatter now reads `status: developing`, and the body
      is byte-identical to the seedling version (only the status line changed).
- [ ] Tap **mature** → reload → frontmatter `status: mature`.

## Capture — Journal (voice + same-day append)

_(automated coverage: `npm run verify:capture-flow` — same-day append/merge
via `writer.test.ts`, `journalTagIndex.test.ts`, and
`test/fixtures/repro.test.ts`; voice dictation itself is still device-only)_

- [ ] Home → **Journal** → press and hold the voice button, dictate a sentence,
      release. The transcript field populates.
- [ ] *(Optional)* type extra notes in the bottom field.
- [ ] **Send** → preview → **Save**.
- [ ] `Journal/YYYY-MM-DD.md` exists with frontmatter and a `# <summary>` heading.
- [ ] Capture a **second** journal entry the same day → reload the file: it now
      holds **both** entries separated by a `## HH:MM` heading; the first is intact
      and its per-entry metadata (tags / location) merged into the day file.

## Capture — Person (with the LLM gateway)

- [ ] Settings → OmniRoute URL set and reachable.
- [ ] Home → **Contact** → **Scan card** → camera opens → **Capture** on a real
      business card. OCR runs; the OCR text field populates.
- [ ] Add a context note ("met at conference X") → **Send** → preview → **Save**.
- [ ] `People/<Firstname-Lastname>.md` exists with frontmatter (`name`, `company`,
      `email`, …).

## Capture — Person (without the gateway)

- [ ] Settings → clear the OmniRoute URL → Save.
- [ ] Home → **Contact** → scanning surfaces the friendly banner: *"OmniRoute not
      configured. Type the card text below, then tap Send."*
- [ ] Type the OCR text + context manually → **Send** → **Save** → the file still
      lands on disk.

## Offline queue (capture while unreachable)

_(automated coverage: `npm run verify:capture-flow` — queue persistence/drain
logic via `queue.test.ts`; the airplane-mode/force-quit device behavior
itself is still manual)_

- [ ] Put the phone in airplane mode (or stop the gateway). Capture an idea →
      **Send**. The capture is buffered on-device (AsyncStorage, `lib/queue.ts`),
      surfaced as queued — **not** a wedged UI or a lost note.
- [ ] Re-enable the network → the queue **drains automatically** and the note
      lands in the vault.
- [ ] Force-quit the app while a capture is queued → relaunch → the queue persists
      and drains on reconnect. No orphaned/partial file in the vault (atomic
      tmp+rename write).

## Rich edit (WYSIWYG / RecentDetail)

_(automated coverage: `npm run verify:capture-flow` — byte-intact frontmatter
across body-only edits via `markdownRoundTrip.test.ts`)_

- [ ] Open a note from Recents → **RecentDetail**. The TenTap WYSIWYG editor loads
      the body; tags chip, geo chip, and attachments render.
- [ ] Make an edit → **Save** → reload the file: the change persisted and the
      frontmatter header is byte-intact (no block collapse — the #1 WYSIWYG
      corruption mode).

## Karakeep export (optional)

- [ ] Settings → Karakeep URL + API key set.
- [ ] Open a note → **Send to Karakeep** → snackbar *"Exported to Karakeep"*. On
      the Karakeep instance: a text bookmark with the note body + the note's tags,
      and any image/file attachments uploaded as assets.
- [ ] **Re-export** the same note → confirm dialog *"This note is already in
      Karakeep. Update the existing bookmark…"* → **Update** → snackbar *"Updated
      in Karakeep"*. The **same** bookmark updates — no duplicate is created.
- [ ] Add a new image/file attachment to the note → re-export → **only the new
      attachment** is pushed; previously-synced assets are not duplicated
      (incremental asset sync).
- [ ] With the Karakeep URL blank, **Send to Karakeep** surfaces a "not configured"
      error instead of failing silently.
- [ ] Sharing/attaching a non-image, non-PDF file (e.g. `.txt`) and exporting →
      snackbar notes *"…is a file type Karakeep doesn't accept — kept in the vault
      only"*; the bookmark exists without the attachment (server allowlist, expected).

## Karakeep pending-sync queue (host unreachable)

(Device-verified end-to-end 2026-07-16; automated coverage:
`src/lib/pendingSync.test.ts`, `pendingSyncRunner.test.ts`, `hostReachability.test.ts`.)

- [ ] With the Karakeep host unreachable (airplane mode, or Tailscale off for a
      tailnet host): **Send to Karakeep** → after the ~20s timeout, snackbar
      *"Karakeep is unreachable — export queued…"* (NOT the red error banner).
- [ ] Home shows *"N export(s) waiting for Karakeep — will send when the server is
      reachable"* with a **Retry** button; tapping Retry while still offline is a
      fast no-op (~4s) and the banner stays.
- [ ] Restore connectivity → background then re-foreground the app → the queue
      drains automatically (no Retry tap); the note gains a `karakeepId` and the
      banner clears on the next Home focus (count may lag one focus — known).

## Voice setup (STT onboarding)

- [ ] **Settings → Voice input → Check voice setup** reports the recognizer/model
      state: "ready", or an offer to **Download voice model** when the on-device
      English model is missing (the code-12 dictation dead-end).
- [ ] On a device that lacks the English model, the Home screen also shows a
      one-shot readiness banner once. (Both attached Pixels currently have the
      model, so this path needs a model-less device to exercise.)

## Unicode + collision edge cases

_(automated coverage: `npm run verify:capture-flow` — slug collision and
non-Latin H1 handling via `writer.test.ts` and `test/fixtures/repro.test.ts`)_

- [ ] Capture an idea titled `Mémoire & flux` → file lands at
      `Ideas/memoire-flux.md` (transliterated, not "untitled").
- [ ] Capture another idea that resolves to the same slug → `Ideas/memoire-flux-2.md`
      (collision suffix). The original file is untouched.

## Desktop (optional)

`apps/desktop` is a **Tauri v2 placeholder stub** (see README / TODO.md) — its
capture path is not part of the mobile smoke flow.

- [ ] `npm run desktop:tauri` opens the Carnet window without error.
- [ ] The LLM-gateway token is held in the OS keychain via the Tauri commands
      (`get/set/delete_navetted_token`), not plaintext.

## When something fails

1. Note the step, the observed vs. expected behavior, and the relevant vault file
   if one landed wrongly.
2. **Enrichment** failures → check the OmniRoute URL + key in Settings and that the
   gateway is reachable from the phone (Tailscale/LAN).
3. **Export** failures → check the Karakeep URL + key, that the URL is `https://`
   (loopback/`10.x` HTTP excepted), and that the instance is reachable.
4. File an issue with the step number, logs, and the offending vault file/frontmatter.
