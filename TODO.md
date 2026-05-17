# Carnet — TODO

Tracking deferred MVP scope and known issues.

## Deferred (intentional, MVP scope)

- [ ] **Person camera capture pipeline** — `apps/mobile/src/screens/CaptureScreen.tsx` `PersonInput` button shows a placeholder message. Wire up: `expo-camera` capture → base64 → `ocrBusinessCard()` (already implemented in `apps/mobile/src/lib/ocr.ts`) → populate `ocrText`.
- [ ] **Desktop business logic** — `apps/desktop` is a Tauri stub. Single window placeholder + tray "Ouvrir Carnet". Reuse `@carnet/shared`'s `NavettedClient` to add capture flows.
- [ ] **QR pairing flow** — Mobile auth currently requires manual paste of navetted URL + token in Settings. Add QR scan reusing the navetted pairing payload format (`navette://<base64>` with `{host, port, token, tls}`).
- [ ] **Tests** — Per spec, no test files written for shared/mobile. `navette/src/capture/handlers.rs` has 8 unit tests; everything else is testable but untested.

## Known issues to address before real-device use

- [x] **Mobile tokens in plaintext AsyncStorage** — Now stored in `expo-secure-store` (`apps/mobile/src/lib/settings.ts`). Migrates legacy AsyncStorage tokens on first read.
- [x] **Desktop tokens in plaintext localStorage** — Now stored in the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service) via three Tauri commands wrapping the `keyring` crate. Migrates legacy localStorage tokens on first read.
- [x] **WS read-loop blocks during `claude -p`** — Decoupled in Entrevoix/navette#35. Each capture handler now runs in its own `tokio::spawn`, replies flow back through a per-connection `mpsc<Message>` channel drained by the WS `select!`. Plus per-connection capture-concurrency cap (`max_concurrent_captures`, default 4), panic guard via nested `JoinHandle`, and ack-before-persist so mid-flight disconnects no longer duplicate files in the sync folder.
- [x] **Daemon-side `claude -p` timeout** — Hard 120s ceiling lands in `navette/src/capture/claude.rs` (PR Entrevoix/navette#34). Per-request configurable timeout still pending.

## Nice-to-have (post-MVP)

- [ ] **OmniRoute fallback** — `apps/mobile/src/lib/ocr.ts` throws cleanly if URL is unset. Today, `PersonInput` just shows an error. Consider auto-suggesting "type the OCR text below" as a friendlier path.
- [ ] **Connection status surfacing** — `CaptureScreen` shows `navetted: <status>` text but Home doesn't. A small indicator on Home would help diagnose pairing/network issues.
- [ ] **Slugify edge cases** — `navette/src/capture/handlers.rs` `slugify()` is ASCII-only and drops non-Latin characters. For French accents this is fine (drops accents → still readable), but for non-Latin titles you get an empty slug → "untitled". Consider a Unicode-aware slugifier (e.g. `deunicode` crate) if this comes up in practice.
- [ ] **Journal append separator** — Currently `\n\n---\n\n`. Consider including a timestamp in each appended block so multiple captures in a single day are distinguishable.
- [ ] **Settings: live connection test** — Add a "Tester la connexion" button on Settings that connects, hellos, and reports success/failure without needing to attempt a capture.
- [ ] **Idea status progression** — `IdeaNote.status` supports `seedling | developing | mature` per the type, but the prompt always emits `seedling`. No UI to promote.
- [ ] **Filename collision** — Two ideas with the same title overwrite. Consider appending a date suffix or a short hash on collision.
