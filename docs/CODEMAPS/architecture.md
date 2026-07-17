# Architecture — Carnet
<!-- Generated: 2026-07-17 | Files scanned: ~152 (87 src + tests) | Token estimate: ~820 -->

Mobile-first knowledge capture. The Android app writes Markdown into a local folder;
Syncthing replicates it peer-to-peer into an Obsidian vault on the workstation.
**No server, no database** — the vault (plain files) is the source of truth.

## Workspaces (npm monorepo, v0.2.0)
- `apps/mobile`    — Expo SDK 54 / React Native 0.81 — the primary surface
- `apps/desktop`   — Tauri (Rust) + React — intentional stub, fate deferred (TODO.md)
- `packages/shared` — `@carnet/shared` — TS types + markdown helpers (no app deps)

## Data flow
```
Capture (Idea / Journal / Contact / Photo / Audio / Share / notification inline-reply)
  → backend dispatcher            lib/dispatcher.ts  (B7 seam: "omniroute" | future on-device)
  → enrich via LLM client         lib/omniroute.ts   (OpenAI-compatible /v1/chat/completions;
       vision: enrichSharedImage + ocrCardViaVision on visionModel; stream:false always)
  → sanitize LLM output           lib/enrichSanitize.ts  (B3, at the executeChat chokepoint)
  → render Markdown               lib/writer.ts
  → write local folder            {captureFolderPath}/{Ideas,Journal,People,Photos,Attachments}
        │  (offline → lib/queue.ts buffers in AsyncStorage, drains when online)
        │  (Idea/Journal default SAVE-FIRST: file lands instantly, enrichment patches after — B4)
        ▼  Syncthing p2p
  ~/Obsidian/Carnet/              workstation vault (Obsidian opens it directly)

Export (opt-in, per note, from RecentDetail)
  → lib/karakeepNoteExport.ts → lib/karakeep*.ts (HTTPS REST)
  → self-hosted Karakeep: bookmark + tags + assets
        │  (host unreachable, status-0 → lib/pendingSync.ts queues; drains on app
        │   foreground once lib/hostReachability.ts probe answers — VPN/Tailscale-aware)
```

## Layer boundaries
- **UI** `screens/` (9), `components/` (14) — capture + review + search
- **Domain** `lib/` (53 modules, each with co-located tests) — enrichment (dispatcher
  seam covers ALL backend-divergent calls incl. transcribe/OCR/listModels), sanitize,
  markdown/frontmatter, vault IO behind the `VaultFs` seam (SAF/file:// selected once)
  + tag/search index + sync-conflict detection, offline queue + pending-sync (Karakeep)
  queue over shared scaffolding, shared HTTP-client security core (`httpClient.ts`),
  save-first flows, related-notes scoring, cold-start budget, settings, net allowlist
  (B0 SSRF/host hardening), Karakeep export, host reachability, notification capture
- **Voice** `voice/` — on-device STT: recognizer detection/failover (`recognizerSelect`),
  pure error-decision ladder (`sttErrorPolicy` — restart latching, silence auto-stop,
  mic-revoked classification), onboarding/readiness
- **Native bridges** `bridges/` + `editor-web/` (TenTap WebView WYSIWYG)
- **External** — OmniRoute (self-hosted LLM gateway, all AI calls), Karakeep (export),
  Syncthing (sync), Android STT RecognitionServices, camera/mic/location

## Security invariants
No `.env`; runtime config entered in-app (keys in SecureStore). `netAllowlist.ts` pins
outbound hosts. Frontmatter stays byte-compatible with existing vault files.

See `backend.md` (device pipeline + integrations), `frontend.md` (screens),
`data.md` (vault schema + stores), `dependencies.md` (integrations).
