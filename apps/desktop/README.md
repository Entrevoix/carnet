# @carnet/desktop

**This is a stub.** The desktop app does not yet implement capture flows. It
opens a single window showing "Application de bureau — bientôt disponible" and
installs a system tray icon with one menu item ("Ouvrir Carnet") that
re-focuses the window.

The full Tauri build pipeline (Vite + React + Rust) is in place so the app
can be picked up later without re-scaffolding.

## Run

```bash
# From the repo root
npm run desktop:tauri
```

Requires Rust + the Tauri v2 platform prerequisites (per https://v2.tauri.app/start/prerequisites/).
