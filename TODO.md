# Carnet — TODO

Tracking deferred v0.3 scope and known issues.

## Resolved in v0.2

- [x] **Filename collision** — `writer.ts` appends `-2`, `-3` etc. on slug collision.
- [x] **Journal append separator with timestamp** — Each appended block is separated by `\n\n---\n<timestamp>\n\n` so multiple same-day entries are distinguishable.
- [x] **Mobile tokens in plaintext AsyncStorage** — `omniRouteApiKey` stored in `expo-secure-store`. Legacy navetted token cleared on migration.
- [x] **Desktop tokens in plaintext localStorage** — Stored in OS keychain via Tauri keyring commands.
- [x] **Connection status surfacing** — No longer relevant: no daemon to connect to. OmniRoute uses plain HTTPS; offline state is handled by the capture queue.
- [x] **navetted dependency** — Removed entirely. OmniRoute + Syncthing replaces the WS daemon architecture.

## Deferred to v0.3

- [ ] **Mobile browse + search** — High value but large UX surface. Build after v0.2 proves out the capture flow.
- [ ] **Auto-capture surfaces** — Quick Tile (Android), share extension, Android Auto. Per-OS platform work; validate v0.2 first.
- [ ] **Retrospective query** — "What have I been thinking about regarding X?" Needs browse/search first.
- [ ] **Bidirectional sync awareness** — Mostly works via Syncthing. A mobile file watcher to detect workstation edits is a v0.3 enhancement.
- [ ] **Card auto-detection** — Current button-press OCR flow works. Auto-detect when camera sees a business card is polish.
- [ ] **Cross-capture linking** — Person ↔ journal associations via prompt-side linking. Iterate after v0.2 ships.
- [ ] **Multi-vault support** — Single-vault solves the actual problem. Premature to add vault switching now.
- [ ] **Desktop app fate** — `apps/desktop` is a Tauri v2 stub. Decide rebuild or deprecate after v0.2 mobile dogfooding.
- [ ] **Whisper → OmniRoute consolidation** — Voice transcription currently uses Expo's speech recognition. Consolidate through OmniRoute once its audio support is confirmed.

## Deferred (carry-over from v0.1)

- [ ] **Person camera capture pipeline** — `PersonInput` wires up `expo-camera` → `ocrBusinessCard()` (implemented in `lib/ocr.ts`). The button is present; the full pipeline needs integration testing on device.
- [ ] **Slugify Unicode edge cases** — ASCII-only slugifier drops non-Latin characters. For French accents this is fine; for non-Latin titles you get "untitled". Consider a Unicode-aware slugifier if this comes up in practice.
- [ ] **Settings: live connection test** — A "Tester la connexion" button that pings OmniRoute and reports latency/auth status.
- [ ] **Promote-idea race condition** — If Syncthing updates the file between mobile read and write, the edit is lost. Detect mtime change between read and write, surface a conflict in UI.
