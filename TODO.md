# Carnet — TODO

Tracking deferred v0.3 scope and known issues.

## Resolved in v0.2

- [x] **Filename collision** — `writer.ts` appends `-2`, `-3` etc. on slug collision.
- [x] **Journal append separator with timestamp** — Each appended block is separated by `\n\n---\n<timestamp>\n\n` so multiple same-day entries are distinguishable.
- [x] **Mobile tokens in plaintext AsyncStorage** — `omniRouteApiKey` stored in `expo-secure-store`. Legacy navetted token cleared on migration.
- [x] **Desktop tokens in plaintext localStorage** — Stored in OS keychain via Tauri keyring commands.
- [x] **Connection status surfacing** — No longer relevant: no daemon to connect to. OmniRoute uses plain HTTPS; offline state is handled by the capture queue.
- [x] **navetted dependency** — Removed entirely. OmniRoute + Syncthing replaces the WS daemon architecture.

## Resolved in Stage 2 (2026-07-10)

Backend-generalization + capture-surface audit (`AUDIT-backend.md`, PR #62) → execution
plan (`.claude/PRPs/plans/stage2-backend-and-capture.plan.md`, branches B0–B7). All
branches shipped (B2 folded via `visionModel`, gate passed 2026-07-12).

- [x] **B3 — LLM markdown sanitizer + frontmatter normalizer** (PR #63) — `lib/enrichSanitize.ts`;
  neutralizes Dataview/Templater/script/`javascript:` injection in LLM output before it
  reaches the vault, without deleting legitimate user-authored code blocks or breaking
  inline images (#60). The dogfooding-safety gate.
- [x] **B0 — network-control hardening** (PR #64, hardened further by #69) — exact-host
  allowlist (`lib/netAllowlist.ts`) replacing prefix-regex matching; manual-redirect
  SSRF guard on URL preview fetches.
- [x] **B1 — per-task model split** (PR #65) — `omniRouteVisionModel` setting, distinct
  from the chat model, so a text-only model can never silently drop an image part.
  Resolves the vestigial `omniRouteTranscriptionModel` question below by repurposing it.
- [x] **B4 — save-first capture timing for Idea** (PR #66) — raw note saves immediately;
  enrichment updates it in place; net-new mtime conflict guard (also closes the
  promote-idea race noted below in "Resolved (carry-over from v0.1)").
- [x] **B5 — notification inline reply** (PR #71, fix #74) — RemoteInput "quick idea"
  action on the persistent capture notification; zero-app-open text capture, depends on
  B4's save-first path.
- [x] **B6 — vault browse + search, Phase 1** (PR #67) — supersedes "Mobile browse +
  search" below; note-metadata index (`carnet:noteindex:v1`, AsyncStorage) generalizing
  the tag-index pattern, new Search screen. Phase 2 (on-demand full-text) and Phase 3
  (retrospective query, below) remain separate later plans, now unblocked.
- [x] **B7 — pluggable on-device backend, Phase 1** (PR #72) — interface-only dispatcher
  seam (`lib/dispatcher.ts`) re-exporting the six enrich functions from the selected
  backend; `Settings.llmBackend` (default `"omniroute"`). No native code yet — this is
  the prerequisite the "On-device Gemma backend" item below now builds on.
- [x] **B2 — fold business-card OCR into chat vision** — done; folded via `visionModel`,
  gate passed 2026-07-12. The dedicated `POST {omniRouteUrl}/ocr` client (`lib/ocr.ts`) is
  retired; `CardScannerModal` now calls `ocrCardViaVision()` in `lib/omniroute.ts`, an
  `image_url` chat-vision call on the vision model. Side-by-side vs. the old Mistral `/ocr`
  endpoint on real cards matched (and beat it on stylized text).
- [x] **Screen-file decomposition** (`.agent_native/agent_roadmap.md` item #2, PRs #101–#103)
  — extracted business logic from the three oversized screen files into tested `lib/*.ts`
  modules: `CaptureScreen.tsx` 1175→798 lines, `RecentDetailScreen.tsx` 1599→1416,
  `SettingsScreen.tsx` 849→794 (smaller by design — mostly legitimate form UI, not hidden
  logic). 10 new modules, each behavior-preserving and independently code-reviewed.

## Deferred to v0.3

- [ ] **Auto-capture surfaces** — Android Quick Settings tile dropped from the roadmap
  (2026-07-04 decision): the persistent notification (shipped) + B5's inline-reply cover
  the same latency profile. iOS share extension and Android Auto remain open; Android
  share sheet is already shipped.
- [ ] **Browse/search Phase 2 + 3** — on-demand full-text search and the retrospective
  query ("What have I been thinking about regarding X?") build on B6 Phase 1 (shipped
  above) as separate later plans.
- [ ] **Bidirectional sync awareness** — Mostly works via Syncthing. A mobile file watcher to detect workstation edits is a v0.3 enhancement.
- [ ] **Card auto-detection** — Current button-press OCR flow works. Auto-detect when camera sees a business card is polish.
- [ ] **Cross-capture linking** — Person ↔ journal associations via prompt-side linking. Iterate after v0.2 ships.
- [ ] **Multi-vault support** — Single-vault solves the actual problem. Premature to add vault switching now.
- [ ] **Desktop app fate** — `apps/desktop` is a Tauri v2 stub. Decide rebuild or deprecate after v0.2 mobile dogfooding.
- [ ] **On-device Gemma backend, Phases 2–4** — native module + model download. B7 Phase 1
  (shipped above) built the dispatcher seam this needs; the native-code phases (add a
  `localLlm.ts` sibling behind the seam) are still unstarted. Trade-offs unchanged:
  ~1.5GB model file, slow first-token (~3-8s on phone), battery cost. Skip the workstation
  Ollama variant: it re-introduces the daemon dependency v0.2 deliberately removed.
- [ ] **Encrypt offline queue payloads at rest** — Currently `queue.ts` stores `payload_json` (raw user idea text, voice transcripts, OCR'd business-card PII including names/emails/phones) as plaintext in AsyncStorage (a JSON array under a single key — the queue moved off expo-sqlite entirely per this repo's no-SQLite constraint; `payload_json` is just a legacy field name, not an actual SQLite column). AsyncStorage on Android is unencrypted by default. The realistic threat is a rooted / debug-enabled device, an adb pull, or a malicious app with `INSTALL_PACKAGES` privilege. For carnet's single-developer threat model this is defense-in-depth, not a blocker — but it should land before any non-developer dogfooding. Approach: encrypt `payload_json` with a key kept in `expo-secure-store` (AES-GCM via `expo-crypto`) before the AsyncStorage write. (A SQLite-backed encryption path like `op-sqlite`/`expo-sqlite-encrypted` is off the table — see CLAUDE.md's no-SQLite constraint.)

## Deferred (carry-over from v0.1)

- [ ] **Person camera capture pipeline** — `CardScannerModal` (opened from `CaptureModeInput`) wires up `expo-camera` → `ocrCardViaVision()` (in `lib/omniroute.ts`; the standalone `lib/ocr.ts` `/ocr` client was retired in B2). The button is present; the full pipeline needs integration testing on device.
- [ ] **Slugify Unicode edge cases** — ASCII-only slugifier drops non-Latin characters. For French accents this is fine; for non-Latin titles you get "untitled". Consider a Unicode-aware slugifier if this comes up in practice.
- [ ] **Settings: live connection test** — A "Tester la connexion" button that pings OmniRoute and reports latency/auth status.
- [x] **Promote-idea race condition** — Closed by the B4 mtime conflict guard (`writer.ts` `getModificationTime` + `updateNoteIfUnchanged`). Promote now records the file's `modificationTime` before its read-modify-write and re-checks it before the overwrite; a Syncthing/workstation edit that landed in between is kept (write skipped) and a conflict message is surfaced in `CaptureScreen`. The same guard backs the save-first Idea enriched overwrite and the offline-drain in-place update.
