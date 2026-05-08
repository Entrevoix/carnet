# Carnet — Real-device smoke test

End-to-end verification you can run with a phone, a workstation running
`navetted`, and (optionally) a desktop with the Tauri stub. Use this list
before tagging a release or after any change touching the WS, capture
handlers, or storage layer.

Tick boxes inline as you go. Most steps take under a minute.

---

## Prerequisites

- [ ] Workstation has `navetted` built and `claude` CLI on PATH
- [ ] `~/.config/navetted/config.toml` has `[carnet] sync_folder = "/path/to/Obsidian/Carnet"` set
- [ ] Phone and workstation are on the same Tailscale net or LAN
- [ ] Phone has Expo Go installed (or a dev build of carnet)
- [ ] (Optional) Workstation has the Tauri prerequisites for desktop testing

## Daemon liveness

- [ ] Start `navetted` on the workstation. Log shows
      `WebSocket listening on ws(s)://0.0.0.0:7878` (or your chosen port)
- [ ] In another terminal: `navetted --pair`. QR code prints to terminal.
- [ ] Token from `~/.config/navetted/config.toml` is the same one in the QR.

## Mobile — pairing flow

- [ ] Fresh install (or wipe AsyncStorage): launch carnet on the phone.
- [ ] App boots into **PairScreen** (token is empty).
- [ ] Tap **Scanner le QR** → camera modal opens (grant permission if asked).
- [ ] Point at the navetted QR. App parses the payload, lands on **HomeScreen**.
- [ ] Top-right shows a **green `connecté`** pill within ~5s.
- [ ] Verify the token landed in `expo-secure-store`, not AsyncStorage:
  - On dev: open the React Native debugger and inspect AsyncStorage —
    you should see `carnet:settings:v1` (URL + OmniRoute only) and
    `carnet:client_id:v1`, but NO field named `navettedToken`.

## Mobile — capture/idea (golden path)

- [ ] Tap **💡 Idée** → CaptureScreen.
- [ ] Type a sentence ("test idea — verifying smoke flow").
- [ ] Tap **Envoyer**. Loading state shows "Claude rédige la note…".
- [ ] After a few seconds, preview Card renders with markdown + filepath.
- [ ] Three status chips visible: `seedling` (selected) / `developing` / `mature`.
- [ ] Tap **Enregistrer** → returns to Home, capture appears at the top
      of "Récents".
- [ ] On the workstation, `cat <sync_folder>/Ideas/<slug>.md` shows valid
      Obsidian frontmatter (`created`, `status`, `tags`).

## Mobile — promote idea status

- [ ] Repeat the idea capture, this time tap **developing** in the preview
      Card before tapping Enregistrer. Markdown re-renders.
- [ ] Reload the file: frontmatter now reads `status: developing`.
- [ ] Body content is byte-identical to the seedling version (only the
      status line changed).
- [ ] Tap **mature** → reload → frontmatter `status: mature`.

## Mobile — capture/journal (voice + append)

- [ ] Tap **🎙 Journal** → CaptureScreen.
- [ ] Press and hold the VoiceButton, dictate a sentence, release.
      Transcript field populates.
- [ ] Optionally type extra notes in the bottom field.
- [ ] Envoyer → preview → Enregistrer.
- [ ] `<sync_folder>/Journal/YYYY-MM-DD.md` exists with frontmatter and
      a `# <summary>` heading.
- [ ] Capture a SECOND journal entry the same day.
- [ ] Reload the file: it now contains both entries, separated by a
      `## HH:MM` heading. The first entry is intact.

## Mobile — capture/person (with OmniRoute)

- [ ] Settings → set OmniRoute URL to your reachable instance.
- [ ] Home → 👤 Contact → CaptureScreen.
- [ ] Tap **Scanner la carte** → camera modal opens.
- [ ] Point at a real business card, tap **Capturer**.
- [ ] Modal shows "OCR en cours…", then closes; OCR text field on the
      capture screen is populated.
- [ ] Type a context note ("met at conference X").
- [ ] Envoyer → preview → Enregistrer.
- [ ] `<sync_folder>/People/<Firstname-Lastname>.md` exists with
      frontmatter (`name`, `company`, `email`, …).

## Mobile — capture/person (without OmniRoute)

- [ ] Settings → clear OmniRoute URL → Save.
- [ ] Home → 👤 Contact.
- [ ] Tap **Scanner la carte** → friendly info banner appears
      ("OmniRoute non configuré. Saisis le texte de la carte ci-dessous…").
- [ ] Type the OCR text + context manually.
- [ ] Envoyer → preview → Enregistrer.
- [ ] File still lands on disk.

## Mobile — settings test connection

- [ ] Settings → change `navetted token` to garbage.
- [ ] Tap **Tester la connexion**.
- [ ] Within ~1s, red HelperText: `rejected: bad hmac` (or similar
      auth-failure message).
- [ ] Restore the correct token → Tester la connexion → green
      `Connecté en NNNms`.

## Mobile — connection resilience

- [ ] With the app on Home (green pill), kill `navetted` on the workstation.
- [ ] Within ~30s, pill turns amber/red.
- [ ] Restart `navetted`. Pill returns to green within the next reconnect
      window (exponential backoff up to 30s).

## Mobile — Unicode + collision edge cases

- [ ] Capture an idea titled `Mémoire & flux` → file lands at
      `Ideas/memoire-flux.md` (transliterated, not "untitled").
- [ ] Capture another idea that resolves to the same slug → file lands at
      `Ideas/memoire-flux-2.md` (collision suffix). Original file untouched.

## Desktop (optional)

- [ ] `npm run desktop:tauri` opens the Carnet window.
- [ ] Click **🎙 Journal** (no voice — text only).
- [ ] Type a journal entry → Envoyer → preview → Enregistrer.
- [ ] File lands in the same sync folder as the mobile captures.
- [ ] Settings → change token to garbage → **Tester la connexion** → red.
      Restore → green.
- [ ] Note: desktop currently stores the token in plaintext localStorage
      (see TODO.md). Do NOT use this build on a shared machine.

## Edge cases worth checking

- [ ] Submit an idea while the app reconnects (kill + restore navetted
      between Submit and the response): expect either a clean error or a
      successful retry, not a wedged UI.
- [ ] Force-quit the mobile app mid-capture → relaunch → no orphaned
      file in the sync folder (atomic write means tmp+rename, no partials).
- [ ] Rapid double-tap Submit on idea: second tap should disable the
      button or report "Not connected" cleanly. (Known limitation: WS
      read loop blocks during `claude -p` — see TODO.md.)
- [ ] Two simultaneous clients (mobile + desktop) connected to the same
      navetted: each can capture without interfering.

## When something fails

1. Note which step failed and capture the navetted log + the WS message
   contents (use `websocat` to replay the failing capture envelope).
2. File an issue with: step number, observed behavior, expected behavior,
   logs, and the relevant section of `<sync_folder>` if a file landed
   wrongly.
3. If the daemon is stuck, `kill` it and check `~/.config/navetted/`
   for a stale lock or a corrupt config (the migration paths in
   `config.rs` are tested, but new fields might trip parsing).
