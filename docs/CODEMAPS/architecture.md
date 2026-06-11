# Architecture — Carnet
<!-- Generated: 2026-06-11 | Files scanned: ~41 | Token estimate: ~650 -->

Mobile-first knowledge capture. The Android app writes Markdown into a local folder;
Syncthing replicates it peer-to-peer into an Obsidian vault on the workstation.
**No server, no database** — the vault (plain files) is the source of truth.

## Workspaces (npm monorepo)
- `apps/mobile`    — Expo SDK 54 / React Native 0.81 — the primary surface
- `apps/desktop`   — Tauri (Rust) + React — tiny companion; stores the LLM-gateway token
- `packages/shared` — `@carnet/shared` — TS types + markdown helpers (used by both apps)

## Data flow
```
Capture (Idea / Journal / Person / Photo / Audio)
  → enrich via LLM client      lib/omniroute.ts   (HTTPS → OmniRoute / navetted)
  → render Markdown            lib/writer.ts
  → write local folder         /Documents/carnet/{Ideas,Journal,People,Photos,Attachments}
        │  (offline → lib/queue.ts buffers in AsyncStorage, drains when online)
        ▼  Syncthing p2p
  ~/Obsidian/Carnet/           workstation vault (Obsidian opens it directly)
```

## Layer boundaries
- **UI** `screens/`, `components/` — capture + review
- **Domain** `lib/` — enrichment, markdown/frontmatter, vault IO, offline queue, tags, location
- **Native bridges** `bridges/`, `voice/`, `editor-web/` (TenTap) — STT, OCR, WYSIWYG
- **External** — OmniRoute/navetted (LLM, HTTPS), Syncthing (sync), device sensors/camera/mic

See `backend.md` (device pipeline), `frontend.md` (screens), `data.md` (vault schema),
`dependencies.md` (integrations).
