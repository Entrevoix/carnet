# Carnet

Mobile-first knowledge capture for Obsidian, with LLM enrichment via OmniRoute and sync via Syncthing.

## Architecture

```
ANDROID MOBILE (Expo + RN)                  WORKSTATION
┌───────────────────────────────┐          ┌──────────────────────────┐
│ CaptureScreen.tsx             │          │                          │
│  ├ Idea (text)                │          │  ~/Obsidian/Carnet/      │
│  ├ Journal (voice→text)       │  HTTPS   │     Ideas/{slug}.md      │
│  └ Person (camera→OCR)        │ ───────► │     Journal/YYYY-MM-DD.md│
│         │                     │          │     People/F-L.md        │
│         ▼                     │          │            ▲             │
│  lib/omniroute.ts (LLM)       │          │            │             │
│  lib/prompts.ts (3 modes)     │          │     Syncthing daemon     │
│  lib/writer.ts (md to disk)   │          │            ▲             │
│  lib/queue.ts (offline)       │          │            │             │
│         │                     │          │            │             │
│         ▼                     │          │            │             │
│  Local folder ────────────────┼──────────┼─► carnet/ folder         │
│  /Documents/carnet/           │ Syncthing p2p                       │
│         │                     │                                     │
│         ▼                     │                                     │
│  Syncthing Android app        │                                     │
└───────────────────────────────┘          └──────────────────────────┘

   NO DAEMON. NO CUSTOM RUST. NO HMAC HANDSHAKE.
```

Three capture modes:

| Mode | Input | Output |
|------|-------|--------|
| `idea`    | text                        | `Ideas/{slug}.md` |
| `journal` | voice transcript (+ text)   | `Journal/{YYYY-MM-DD}.md` (appends to existing) |
| `person`  | OCR'd business card + text  | `People/{Firstname-Lastname}.md` |

All three modes go through OmniRoute for LLM enrichment, then write directly to the local capture folder. Offline captures are queued in SQLite and drained on reconnect.

## Layout

```
carnet/
  apps/
    mobile/          Expo 54 + React Native + TypeScript
    desktop/         Tauri v2 stub (placeholder UI, fate deferred to v0.3)
  packages/
    shared/          @carnet/shared — note types + markdown helpers
  docs/
    sync-setup.md    Syncthing setup guide (Android + workstation)
```

## Prerequisites

- Node 20+
- npm 10+
- For mobile: Expo CLI and a physical Android device or emulator
- An **OmniRoute API key** (set in the app's Settings screen)
- **Syncthing** installed on both your Android device and workstation — see [docs/sync-setup.md](docs/sync-setup.md)

No daemon, no navetted, no Rust toolchain required for mobile development.

## Build

```bash
# Install once at root
npm install

# Build the shared package (types + markdown helpers)
npm run build:shared

# Run mobile in Expo
npm run mobile

# Type-check
npm -w @carnet/mobile run typecheck
npm -w @carnet/shared run typecheck
```

## Configuration

Open the **Paramètres** screen in the app and set:

| Setting | Description |
|---------|-------------|
| OmniRoute URL | Base URL of your OmniRoute instance (e.g. `https://llm.grepon.cc`) |
| OmniRoute API key | Your API key — stored in the OS secure keystore via `expo-secure-store` |
| Dossier de capture | Path to your Syncthing-watched folder on Android (e.g. `/storage/emulated/0/carnet`). Leave blank to use the app sandbox. |

### Syncthing sync

See [docs/sync-setup.md](docs/sync-setup.md) for step-by-step instructions to pair the Android capture folder with `~/Obsidian/Carnet/` on your workstation.

## Desktop app

`apps/desktop` is a Tauri v2 placeholder stub. Its fate (rebuild or deprecate) will be decided after v0.2 mobile dogfooding. See TODO.md.

## License

AGPL-3.0-only
