# Contributing to Carnet

Carnet is an **npm-workspaces monorepo**: an Expo / React Native Android app
(`apps/mobile`), a Tauri desktop companion (`apps/desktop`), and shared TypeScript
(`packages/shared`). See [CODEMAPS/architecture.md](CODEMAPS/architecture.md) for the layout.

## Prerequisites
- **Node.js 20** (matches CI)
- **npm** (the repo uses workspaces + `npm ci`)
- Android release builds: **Android SDK** (`ANDROID_HOME`), a JDK, and an attached device/emulator
- Desktop: a **Rust** toolchain (for Tauri)

## Setup
```bash
npm ci
npm run build:shared   # build shared first — mobile & desktop import @carnet/shared
```

## Scripts
<!-- AUTO-GENERATED:scripts -->
**Root**
| Command | Description |
|---|---|
| `npm run build:shared` | Build `@carnet/shared` (run before mobile/desktop) |
| `npm run mobile` | Start the Expo dev server (Metro) |
| `npm run desktop` | Desktop app in Vite dev (web) mode |
| `npm run desktop:tauri` | Desktop app in the Tauri native-shell dev mode |

**apps/mobile**
| Command | Description |
|---|---|
| `npm -w @carnet/mobile start` | `expo start` (Metro dev server) |
| `npm -w @carnet/mobile run android` | Build + run the debug app (`scripts/run-android.sh`) |
| `npm -w @carnet/mobile run android:release` | Build + install the release APK (`scripts/build-release-apk.sh`) |
| `npm -w @carnet/mobile run ios` | `expo run:ios` |
| `npm -w @carnet/mobile run typecheck` | `tsc --noEmit` |
| `npm -w @carnet/mobile test` | Vitest suite |
| `npm -w @carnet/mobile run editor:build` | Build the TenTap WYSIWYG editor-web bundle (Vite) |

**apps/desktop**
| Command | Description |
|---|---|
| `npm -w @carnet/desktop run dev` | Vite dev server (web) |
| `npm -w @carnet/desktop run build` | Type-check then Vite production build |
| `npm -w @carnet/desktop run tauri` | Tauri CLI passthrough |
| `npm -w @carnet/desktop test` | Vitest (`--passWithNoTests`) |

**packages/shared**
| Command | Description |
|---|---|
| `npm -w @carnet/shared run build` | `tsc` emit |
| `npm -w @carnet/shared run typecheck` | `tsc --noEmit` |
| `npm -w @carnet/shared run dev` | `tsc --watch` |
| `npm -w @carnet/shared test` | Vitest |
<!-- /AUTO-GENERATED:scripts -->

## Running locally
- **Mobile (dev):** `npm run mobile`, then `npm -w @carnet/mobile run android`
- **Mobile (release APK):** `npm -w @carnet/mobile run android:release`
- **Desktop:** `npm run desktop` (web) or `npm run desktop:tauri` (native shell)

## Configuration
There are **no `.env` files**. Runtime credentials (the OmniRoute / navetted LLM gateway)
are entered **in-app** on the device via the Settings screen — see
[RUNBOOK.md](RUNBOOK.md).

## Testing
- All workspaces use **Vitest** (`npm -w <workspace> test`).
- Type-check each workspace with `tsc --noEmit`.
- Fix the implementation, not the test, unless the test is wrong.

## CI — must be green before merge
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs four jobs on push/PR:
**shared · mobile · desktop · gate** (install → `build:shared` → typecheck → Vitest).
CI does **not** run the native release build.

## Pull requests
1. Branch off `main`.
2. Conventional commits: `feat` · `fix` · `refactor` · `docs` · `test` · `chore` · `perf` · `ci`.
3. `tsc --noEmit` clean + Vitest green in affected workspaces.
4. Open a PR to `main`; **squash-merge** is the repo convention.
