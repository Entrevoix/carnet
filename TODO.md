# Carnet — TODO

Tracking deferred MVP scope and known issues.

## Deferred (intentional, MVP scope)

- [ ] **Person camera capture pipeline** — `apps/mobile/src/screens/CaptureScreen.tsx` `PersonInput` button shows a placeholder message. Wire up: `expo-camera` capture → base64 → `ocrBusinessCard()` (already implemented in `apps/mobile/src/lib/ocr.ts`) → populate `ocrText`.
- [ ] **Desktop business logic** — `apps/desktop` is a Tauri stub. Single window placeholder + tray "Ouvrir Carnet". Reuse `@carnet/shared`'s `NavettedClient` to add capture flows.
- [ ] **QR pairing flow** — Mobile auth currently requires manual paste of navetted URL + token in Settings. Add QR scan reusing the navetted pairing payload format (`navette://<base64>` with `{host, port, token, tls}`).
- [ ] **Tests** — Per spec, no test files written for shared/mobile. `navette/src/capture/handlers.rs` has 8 unit tests; everything else is testable but untested.

## Known issues to address before real-device use

- [ ] **Tokens in plaintext AsyncStorage** — `apps/mobile/src/lib/settings.ts` saves `navettedToken` via `@react-native-async-storage/async-storage`. Swap to `expo-secure-store` (already in navette's mobile deps; matches the navette pattern). High priority before sharing the binary.
- [ ] **WS read-loop blocks during `claude -p`** — `navette/src/ws.rs` arms await `capture::handlers::handle_*` inline. A 5–30s Claude call blocks that single client's read loop; rapid double-Submit fails with "Not connected". Other clients unaffected. To fix: `tokio::spawn` the handler with a `mpsc` channel back to the sink writer, similar to how `run_session` decouples session work from the WS task.
- [ ] **No request timeout on the daemon side** — Client has a 60s `requestTimeoutMs` (`packages/shared/src/client.ts`). Daemon side has no timeout — a hung `claude` process leaves the WS read loop wedged. Add `tokio::time::timeout` around `run_claude`.

## Nice-to-have (post-MVP)

- [ ] **OmniRoute fallback** — `apps/mobile/src/lib/ocr.ts` throws cleanly if URL is unset. Today, `PersonInput` just shows an error. Consider auto-suggesting "type the OCR text below" as a friendlier path.
- [ ] **Connection status surfacing** — `CaptureScreen` shows `navetted: <status>` text but Home doesn't. A small indicator on Home would help diagnose pairing/network issues.
- [ ] **Slugify edge cases** — `navette/src/capture/handlers.rs` `slugify()` is ASCII-only and drops non-Latin characters. For French accents this is fine (drops accents → still readable), but for non-Latin titles you get an empty slug → "untitled". Consider a Unicode-aware slugifier (e.g. `deunicode` crate) if this comes up in practice.
- [ ] **Journal append separator** — Currently `\n\n---\n\n`. Consider including a timestamp in each appended block so multiple captures in a single day are distinguishable.
- [ ] **Settings: live connection test** — Add a "Tester la connexion" button on Settings that connects, hellos, and reports success/failure without needing to attempt a capture.
- [ ] **Idea status progression** — `IdeaNote.status` supports `seedling | developing | mature` per the type, but the prompt always emits `seedling`. No UI to promote.
- [ ] **Filename collision** — Two ideas with the same title overwrite. Consider appending a date suffix or a short hash on collision.
