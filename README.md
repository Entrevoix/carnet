# Carnet

Mobile-first knowledge capture for Obsidian, with LLM enrichment over WebSocket to navetted.

## Layout

```
carnet/
  apps/
    mobile/          Expo 54 + React Native + TypeScript
    desktop/         Tauri v2 stub (placeholder UI)
  packages/
    shared/          @carnet/shared — types + WebSocket client
```

## Architecture

```
[ Mobile / Desktop ]
       │  WebSocket (port 7878, hello v2 + HMAC-SHA256)
       ▼
[ navetted daemon ]   (lives in the navette repo)
       │  spawns `claude -p "<prompt>"`
       ▼
[ Claude CLI ]  →  Markdown response
       │
       ▼
[ Obsidian sync folder ]  (Ideas/, Journal/, People/)
```

Three capture modes:

| Mode | Input | Output |
|------|-------|--------|
| `idea`    | text                        | `Ideas/{slug}.md` |
| `journal` | voice transcript (+ text)   | `Journal/{YYYY-MM-DD}.md` (append-on-existing) |
| `person`  | OCR'd business card + text  | `People/{Firstname-Lastname}.md` |

## Prerequisites

- Node 20+
- npm 10+
- For mobile: Expo CLI, Xcode/Android Studio simulators or a physical device with Expo Go
- For desktop: Rust toolchain + Tauri v2 prerequisites (per platform)
- A running `navetted` (in the sibling [navette](../navette) repo) with `[carnet] sync_folder = "..."` configured

## Build

```bash
# Install once at root
npm install

# Build the shared package
npm run build:shared

# Run mobile in Expo
npm run mobile

# Run desktop dev (Tauri stub)
npm run desktop:tauri
```

## Configuration

Mobile app settings (in-app, persisted to AsyncStorage):

- `navetted URL`  — `ws://100.x.x.x:7878` (Tailscale IP) or `wss://...` for TLS
- `navetted token` — the secret in `~/.config/navetted/config.toml` on the workstation
- `OmniRoute URL` — `http://192.168.1.20:20128` (used for business-card OCR)

Daemon-side `~/.config/navetted/config.toml`:

```toml
[carnet]
sync_folder = "/home/user/Obsidian/Carnet"
```

## ⚠️ Pre-production warning

The desktop app currently stores the navetted token in **plaintext
localStorage**. This is acceptable for local development on a trusted
machine, but **do not distribute a desktop build** until tokens move to an
OS keychain via Tauri. The mobile app now uses `expo-secure-store` for the
token. See `TODO.md` for tracking.

## License

AGPL-3.0-only
