# Plan: Carnet — Deferred MVP items & nice-to-have polish

## Summary

Roadmap covering the 4 intentionally-deferred MVP items (person camera capture, desktop business logic, QR pairing, tests) and the 7 nice-to-have polish items (OmniRoute UX, connection status, Unicode slug, journal timestamps, settings connection-test, idea status promotion, filename collisions) tagged in `TODO.md` after the MVP build. Organized by file-area to minimize context switching.

## User Story

As a Carnet user, I want a robust capture experience that handles non-Latin titles, repeat captures on the same day, mid-stream visibility into the daemon connection, and the ability to scan a business card on iPhone/Android, so that I can capture knowledge without dropping out of flow into manual fallbacks.

## Problem → Solution

**Current state**: MVP works end-to-end for English idea/journal/person captures, with a manual paste-the-token pairing flow, an unscanned camera button, no desktop, no test suite, and edge cases (Unicode titles, same-day retitling, name collisions) that silently misbehave.

**Desired state**: Each capture mode is fully wired, the desktop client mirrors mobile, pairing is QR-based, every package has a test scaffold, and the obvious polish items (status indicator, connection test, slug fallback, etc.) are landed.

## Metadata

- **Complexity**: Large (11 items, ~30-40 files across both repos)
- **Source PRD**: `TODO.md` — Deferred + Nice-to-have sections
- **PRD Phase**: post-MVP polish
- **Estimated Files**: ~35 changes (carnet) + ~6 (navette)

---

## UX Design

### Before (MVP)

```
┌───────────────────────────────────────────────────────┐
│  Home                                            [⚙]   │
│                                                       │
│  [💡 Idée ]  [🎙 Journal]  [👤 Contact]                │
│                                                       │
│  Récents (5 max)                                      │
│  ─────────                                            │
│  Idée  • il y a 5min   "ma-belle-idee"                │
│                                                       │
│  No connection indicator. User finds out it's down    │
│  only when Submit fails on the next screen.           │
└───────────────────────────────────────────────────────┘

Person mode:  [Scanner la carte]  → MVP placeholder text:
              "Capture caméra non implémentée…"

Settings:  paste URL + token blindly. No way to validate.
```

### After

```
┌───────────────────────────────────────────────────────┐
│  Home                              [● connecté] [⚙]    │
│                                                       │
│  [💡 Idée ]  [🎙 Journal]  [👤 Contact]                │
│                                                       │
│  Récents                                              │
│  ─────────                                            │
│  Idée  • il y a 5min   "ma-belle-idee"                │
│                                                       │
└───────────────────────────────────────────────────────┘

Person mode:  [Scanner la carte] → CameraView → snapshot
              → spinner "OCR en cours…" → text fields auto-populated

Settings:  paste URL + token + [Tester la connexion]
           → "✓ Connecté en 240ms"  or  "✗ bad token"
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Home header | Cog only | Status pill + cog | Reuses `useStatus()` hook |
| Person `Scanner la carte` button | Placeholder error | Camera modal → OCR roundtrip | Camera permissions handled inside the modal |
| Settings save | Silent → reconnect on next capture | Explicit "Tester la connexion" CTA | Reports auth + network latency |
| Pairing | Paste navetted URL + token by hand | Scan QR (`navette://<base64>`) → fields auto-fill | Reuses navette's existing payload format |
| Idea preview | Read-only markdown | Promote `seedling → developing → mature` chips | Edits frontmatter in-place via daemon |
| Same-day journal | Silent append with `---` separator | Append `## HH:MM` heading | Searchable + readable |
| Same-title idea | Overwrites | New file with `-2`, `-3` suffix | Daemon-side dedupe |
| Non-Latin titles | Empty slug → "untitled" | Transliterated slug (`mémoire` → `memoire`) | `deunicode` crate |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0 (critical)** | `navette/src/ws.rs` | 30-50 (helpers), 1389-1495 (capture arms) | Dispatch + helper pattern for new daemon-side messages |
| **P0** | `navette/src/capture/handlers.rs` | full | Existing handler shape, slugify, journal append, file-name derivation — all daemon polish lives here |
| **P0** | `carnet/packages/shared/src/client.ts` | full | `NavettedClient` lifecycle, request_id correlation, status callbacks — every UX item touches this |
| **P0** | `carnet/packages/shared/src/messages.ts` | full | Add new message types (e.g., `ping`, `idea/promote`) here |
| **P0** | `carnet/apps/mobile/src/screens/CaptureScreen.tsx` | 200-260 (PersonInput) | Camera capture wires here |
| **P0** | `carnet/apps/mobile/src/screens/SettingsScreen.tsx` | full | Adds the "Tester la connexion" button |
| **P1 (important)** | `navette/mobile/src/screens/Connect.tsx` | full | Reference for QR scan flow — uses `expo-camera` `CameraView` + `BarcodeScanner` |
| **P1** | `navette/mobile/src/components/VoiceButton.tsx` | 1-100, 800-900 | Permission-request pattern for Camera (mirror for our camera modal) |
| **P1** | `navette/src/main.rs` | 1-15 (mod decls), 87-128 (handle_pair) | Pairing payload format reference for mobile QR parser |
| **P1** | `navette/desktop/src/` (any screen) | sample 1 file | Web-flavoured screen pattern for Tauri React |
| **P2 (reference)** | `carnet/apps/mobile/src/lib/client.ts` | full | Singleton + status-callback shape; the connection indicator subscribes here |
| **P2** | `carnet/apps/mobile/src/lib/ocr.ts` | full | Already wired — camera task just needs to feed it base64 |
| **P2** | `carnet/apps/mobile/src/screens/HomeScreen.tsx` | full | Where the status pill lands |
| **P2** | `navette/Cargo.toml` | 18-42 | Existing deps before adding `deunicode` |
| **P2** | `carnet/packages/shared/package.json` | full | `crypto-js` + `uuid` already there; pattern for adding deps |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `expo-camera` v17 `CameraView` API | https://docs.expo.dev/versions/latest/sdk/camera/ | `takePictureAsync({ base64: true, quality: 0.6 })` returns `{ base64 }` directly |
| `expo-camera` BarCodeScanner | same | `onBarcodeScanned={({data}) => …}` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` |
| Tauri v2 system tray | https://v2.tauri.app/learn/system-tray/ | Tray API already in stub — extend by passing real menu items in `lib.rs` |
| `deunicode` crate | https://docs.rs/deunicode | `deunicode("mémoire")` → `"memoire"`. Lossy, fast, no regex. |
| Vitest | https://vitest.dev/ | Used by navette desktop already; reuse for shared package + Tauri stub |
| pytest-style tabular tests in Rust | `cargo test` + `#[rstest]` | Optional — current `#[test]` style in `handlers.rs` is fine, no rstest needed |

KEY_INSIGHT: navette's existing `mobile/src/screens/Connect.tsx` already implements `navette://<base64>` decoding via `BarcodeScanner` + `JSON.parse(base64decode(payload.slice(10)))`. We can port this verbatim and only swap the URL scheme to `carnet://` (or keep `navette://` since the payload is daemon-centric).

GOTCHA: When promoting an idea status, the daemon must rewrite an existing file, not write a new one. We need a new daemon endpoint (`capture/idea/promote`) that takes `{filepath, status}` and edits frontmatter, otherwise the mobile UI has nothing to invoke.

GOTCHA: `expo-camera` 17.x dropped the legacy `Camera` component — use `CameraView` only. Mobile already pinned to `~17.0.10`.

---

## Patterns to Mirror

### NAMING_CONVENTION_RUST
// SOURCE: navette/src/capture/handlers.rs:1-15
```rust
//! Capture mode handlers. Each handler:
//!   1. Substitutes user input into a prompt template.
//!   …
use std::path::Path;
use anyhow::{Context, Result};
use chrono::Local;
use super::claude::run_claude;
use super::CaptureResponse;
```
- Module-level `//!` doc comment summarising the file's contract
- Imports sorted: std, then external crates, then super/crate
- All handler fns take `&str` inputs + `&str` sync_folder, return `Result<CaptureResponse>`

### ERROR_HANDLING_RUST
// SOURCE: navette/src/capture/handlers.rs:91-93, 119-122
```rust
fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("failed to create {}", dir.display()))
}
```
- `anyhow::Result` everywhere
- `.with_context(|| format!(…))` on every fallible op so `e.to_string()` is informative when it bubbles to the WS handler
- Never `unwrap()` outside tests

### DISPATCH_ARM_PATTERN
// SOURCE: navette/src/ws.rs:1389-1430 (capture/idea arm)
```rust
} else if msg_type == "capture/idea" {
    let request_id = v.get("request_id").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let text       = v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let response = match cfg.carnet.sync_folder.clone() {
        None => capture_error_response(&request_id, "carnet sync_folder not configured …"),
        Some(folder) => match capture::handlers::handle_idea(&text, &folder).await {
            Ok(resp) => capture_ok_response(&request_id, &resp),
            Err(e)   => capture_error_response(&request_id, &e.to_string()),
        }
    };
    if let Ok(s) = serde_json::to_string(&response) {
        if sink.send(Message::Text(s)).await.is_err() { break; }
    }
}
```
- Read every field defensively with `.and_then(.as_str()).unwrap_or("")`
- Match on `cfg.carnet.sync_folder` first — bail with `capture_error_response` if missing
- Echo `request_id` in every response

### NAMING_CONVENTION_TS
// SOURCE: carnet/packages/shared/src/client.ts:1-30
```ts
import HmacSHA256 from "crypto-js/hmac-sha256";
import { v4 as uuidv4 } from "uuid";
import type { CaptureResponse, CaptureType } from "./messages.js";

export type ConnectionStatus = "disconnected" | "connecting" | "authenticating" …;
```
- `.js` extension on local imports (NodeNext + ESM)
- `import type` for type-only imports
- Public types exported, runtime classes use `export class`

### REQUEST_RESPONSE_PATTERN_TS
// SOURCE: carnet/packages/shared/src/client.ts (send method)
```ts
send(type: CaptureType, payload: CapturePayload): Promise<CaptureResponse> {
  return new Promise((resolve, reject) => {
    if (this.status !== "connected" || !this.ws) { reject(...); return; }
    const request_id = uuidv4();
    const envelope = { type, request_id, ...payload };
    const timer = setTimeout(() => { … }, this.requestTimeoutMs);
    this.pending.set(request_id, { resolve, reject, timer });
    this.ws.send(JSON.stringify(envelope));
  });
}
```
- Every new typed method (e.g., `ping()`, `promoteIdea()`) follows this contract
- Always uuid → resolve map → setTimeout for the per-request budget

### MOBILE_SCREEN_PATTERN
// SOURCE: carnet/apps/mobile/src/screens/HomeScreen.tsx
```tsx
type Props = NativeStackScreenProps<RootStackParamList, "Home">;
export default function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const [recent, setRecent] = useState<CaptureEntry[]>([]);
  useLayoutEffect(() => { navigation.setOptions({ headerRight: ... }); }, [navigation]);
  …
}
```
- React Navigation native-stack typing via `RootStackParamList`
- Paper components only — no raw `Pressable` styling
- French strings inline (no i18n yet)

### TEST_STRUCTURE_RUST
// SOURCE: navette/src/capture/handlers.rs:265-310
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Big Idea"), "my-big-idea");
        …
    }
}
```
- Inline `#[cfg(test)] mod tests` per file
- `assert_eq!` over `assert!` for equality
- One scenario per `#[test]`, no parametrisation

### TEST_STRUCTURE_TS
// SOURCE: navette/desktop/vitest.config.ts (existing)
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true } });
```
- Vitest, not Jest, on the carnet side too (matches navette/desktop)
- `*.test.ts` colocated with source for libs; `e2e/*.spec.ts` for Playwright

---

## Files to Change

### navette repo

| File | Action | Justification |
|---|---|---|
| `navette/Cargo.toml` | UPDATE | Add `deunicode = "1"` for Unicode slug |
| `navette/src/capture/handlers.rs` | UPDATE | Unicode slugify, timestamped journal append, idea collision suffix, new `promote_idea` handler |
| `navette/src/capture/mod.rs` | UPDATE | Export `promote_idea` if added there |
| `navette/src/ws.rs` | UPDATE | Add `capture/ping` and `capture/idea/promote` dispatch arms |
| `navette/src/capture/handlers.rs` (tests) | UPDATE | Tests for new behaviour |

### carnet — packages/shared

| File | Action | Justification |
|---|---|---|
| `packages/shared/src/messages.ts` | UPDATE | New message types: `PingPayload`, `PingResponse`, `PromoteIdeaPayload`, `PromoteIdeaResponse` |
| `packages/shared/src/client.ts` | UPDATE | Add `ping()` and `promoteIdea()` methods |
| `packages/shared/src/index.ts` | UPDATE | Re-export new types |
| `packages/shared/src/client.test.ts` | CREATE | Vitest unit tests for `NavettedClient` (mock WebSocket) |
| `packages/shared/vitest.config.ts` | CREATE | Test runner config |
| `packages/shared/package.json` | UPDATE | Add `vitest` + `@types/jsdom` devDeps |

### carnet — apps/mobile

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/secureStorage.ts` | CREATE | `expo-secure-store` wrapper (NOTE: KI #1 — flagged but out-of-scope per user) |
| `apps/mobile/src/lib/useConnectionStatus.ts` | CREATE | Hook subscribing to NavettedClient status |
| `apps/mobile/src/components/StatusPill.tsx` | CREATE | Reusable connection-status indicator |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | Mount StatusPill in headerRight (left of cog) |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | Add "Tester la connexion" button |
| `apps/mobile/src/screens/CaptureScreen.tsx` | UPDATE | Replace PersonInput stub with real CameraView modal; add idea-preview status promote chips |
| `apps/mobile/src/components/CardScannerModal.tsx` | CREATE | expo-camera CameraView modal that captures → calls `ocrBusinessCard()` → returns text |
| `apps/mobile/src/screens/PairScreen.tsx` | CREATE | QR pairing entry point |
| `apps/mobile/src/components/QrScanner.tsx` | CREATE | Reusable QR scanner (mirror navette's `Connect.tsx`) |
| `apps/mobile/App.tsx` | UPDATE | Add `Pair` route; first-launch detection redirects to it |
| `apps/mobile/package.json` | UPDATE | (optional) Add `expo-secure-store` if KI #1 included; add `jest` or rely on no tests |

### carnet — apps/desktop

| File | Action | Justification |
|---|---|---|
| `apps/desktop/src/App.tsx` | UPDATE | Replace placeholder with router |
| `apps/desktop/src/screens/HomeScreen.tsx` | CREATE | Mirror mobile Home (3 buttons + recent list) |
| `apps/desktop/src/screens/CaptureScreen.tsx` | CREATE | Mirror mobile capture (idea/journal text only — no voice/camera on desktop MVP) |
| `apps/desktop/src/screens/SettingsScreen.tsx` | CREATE | Same fields as mobile, persisted via Tauri's filesystem API or localStorage |
| `apps/desktop/src/lib/client.ts` | CREATE | Same singleton pattern as mobile (uses @carnet/shared) |
| `apps/desktop/src/lib/storage.ts` | CREATE | localStorage wrapper for settings + recent captures |
| `apps/desktop/package.json` | UPDATE | Add `@carnet/shared` dependency, `react-router-dom` for routing |
| `apps/desktop/src-tauri/tauri.conf.json` | UPDATE | Bump window default to 900×640 (capture flows need more room) |

## NOT Building

- **Voice on desktop** — VoiceButton is RN-specific (expo-speech-recognition). Web speech recognition is a separate effort; left for later.
- **Camera on desktop** — Tauri can do camera on macOS/Windows but it's a substantially different code path. Person mode on desktop becomes manual paste only.
- **Cloud sync, multi-device sync, search, tags index** — out of scope for polish phase.
- **Mobile token migration to expo-secure-store** — flagged as KI #1 in TODO.md; user explicitly asked for "deferred + 7 NTH". KI list NOT in scope here. (Add as a separate plan.)
- **Daemon-side request timeout** — KI #3, same exclusion as above.
- **Decoupling the WS read loop from `claude -p`** — KI #2, same exclusion.
- **i18n** — French strings stay inline; no translation layer.
- **E2E tests across the WS boundary** — unit tests only for this round.

---

## Step-by-Step Tasks

Tasks are grouped into 6 phases, each independent and individually mergeable. Recommend executing A→B→C→D→E→F so dependencies (e.g., `ping()` in shared used by Settings UI) land in order.

---

### Phase A — navette daemon polish (NTH 3, 4, 7)

#### Task A1: Unicode-aware slugify

- **ACTION**: Replace ASCII-only `slugify()` in `navette/src/capture/handlers.rs` with a transliterating version using `deunicode`.
- **IMPLEMENT**:
  1. Add `deunicode = "1"` to `navette/Cargo.toml` `[dependencies]` (line 41 area, alphabetical).
  2. In `handlers.rs`, change `slugify` to call `deunicode::deunicode(input)` first, then run the existing ASCII-filter loop.
  3. Add a test: `assert_eq!(slugify("Mémoire & flux"), "memoire-flux")`.
- **MIRROR**: Existing `slugify` in `handlers.rs:227-240`. Keep the `prev_dash` collapse logic — only the input gets pre-folded.
- **IMPORTS**: `deunicode::deunicode` (top of handlers.rs).
- **GOTCHA**: `deunicode` is lossy. Some characters become `[?]`; the trailing ASCII filter strips those, so the final slug stays clean.
- **VALIDATE**: `cargo test --package navetted slugify` — all `slugify_*` tests pass.

#### Task A2: Timestamped journal append

- **ACTION**: When `Journal/YYYY-MM-DD.md` exists, append a `## HH:MM` heading instead of a bare `---` separator.
- **IMPLEMENT**: In `handle_journal`, replace the existing append branch:
  ```rust
  let now = Local::now().format("%H:%M").to_string();
  let appended = strip_frontmatter(&markdown);
  format!(
      "{}\n\n## {now}\n\n{}",
      existing.trim_end(),
      appended.trim_start()
  )
  ```
- **MIRROR**: `handlers.rs` `handle_journal` block-existing branch.
- **IMPORTS**: `chrono::Local` (already imported).
- **GOTCHA**: Don't double-strip frontmatter — `strip_frontmatter` already handles missing frontmatter.
- **VALIDATE**: New test `journal_append_uses_time_heading` — write a stub file, call `handle_journal`, assert the result contains `## ` followed by `HH:MM` pattern.

#### Task A3: Idea title collision suffix

- **ACTION**: In `handle_idea`, if `Ideas/<slug>.md` exists, try `<slug>-2.md`, `<slug>-3.md`, … up to 99.
- **IMPLEMENT**: Wrap the `let filepath = dir.join(...)` block:
  ```rust
  let mut filepath = dir.join(format!("{final_slug}.md"));
  let mut n = 2u32;
  while filepath.exists() && n < 100 {
      filepath = dir.join(format!("{final_slug}-{n}.md"));
      n += 1;
  }
  if filepath.exists() { anyhow::bail!("more than 99 ideas with slug {final_slug}"); }
  ```
- **MIRROR**: Same handler.
- **IMPORTS**: None new.
- **GOTCHA**: Cap iteration; without a bound a pathological slug could loop on a corrupt FS. 99 is plenty for a personal capture system.
- **VALIDATE**: Test `idea_collision_appends_suffix` — pre-create `Ideas/test.md`, call `handle_idea`, assert filepath ends in `test-2.md`.

#### Task A4: `capture/idea/promote` daemon endpoint (supports NTH 6)

- **ACTION**: Add a new handler that rewrites the `status:` frontmatter line of an existing idea file.
- **IMPLEMENT**: New `pub async fn promote_idea(filepath: &str, status: &str) -> Result<CaptureResponse>` in `handlers.rs`:
  ```rust
  pub async fn promote_idea(filepath: &str, status: &str) -> Result<CaptureResponse> {
      if !["seedling", "developing", "mature"].contains(&status) {
          anyhow::bail!("invalid status: {status}");
      }
      let content = std::fs::read_to_string(filepath).with_context(|| format!("read {filepath}"))?;
      let updated = rewrite_frontmatter_field(&content, "status", status)?;
      write_atomic(Path::new(filepath), &updated)?;
      Ok(CaptureResponse {
          filepath: filepath.to_string(),
          preview_markdown: updated,
      })
  }
  ```
  Add helper:
  ```rust
  fn rewrite_frontmatter_field(content: &str, field: &str, new_value: &str) -> Result<String> {
      // Find frontmatter block, rewrite the matching line, leave body untouched.
  }
  ```
- **MIRROR**: `handlers.rs` `extract_frontmatter_field` for parsing logic; `write_atomic` for the save.
- **IMPORTS**: None new.
- **GOTCHA**: Don't accept arbitrary `field` from the wire — hardcode it to `"status"`. Don't rewrite anything if the field isn't already in the frontmatter.
- **VALIDATE**: Test `promote_idea_rewrites_status` — write fixture file with `status: seedling`, call `promote_idea(path, "developing")`, read result, assert `status: developing` and the body is byte-identical.

#### Task A5: `capture/idea/promote` and `ping` WS arms

- **ACTION**: Add two new dispatch arms in `navette/src/ws.rs` before the final `else` (currently around line 1493 after Phase A handlers land).
- **IMPLEMENT**:
  - `else if msg_type == "ping"` → respond `{type: "pong", request_id, server_ts: unix_ts()}`. No carnet.sync_folder check.
  - `else if msg_type == "capture/idea/promote"` → extract `filepath`, `status`; call `capture::handlers::promote_idea`; reuse `capture_ok_response` / `capture_error_response`.
- **MIRROR**: Existing `capture/idea` arm at `ws.rs:1389-1416`.
- **IMPORTS**: None new.
- **GOTCHA**: `ping` is the only capture-adjacent message that doesn't require a sync_folder. Don't gate it.
- **VALIDATE**: `cargo check --all-targets` clean. Manual: send a `ping` JSON and confirm `pong` echoes back with `request_id`.

---

### Phase B — packages/shared (NTH 5)

#### Task B1: `ping` and `promoteIdea` typed methods

- **ACTION**: Add typed methods + new message types to `@carnet/shared`.
- **IMPLEMENT**:
  - `messages.ts`: add `PingPayload = {}`, `PingResponse = { type: "pong", request_id, server_ts: number }`, `PromoteIdeaPayload = { filepath, status: IdeaStatus }`, reuse `CaptureResponse` for the promote response.
  - `client.ts`: add
    ```ts
    async ping(): Promise<{ rttMs: number; serverTs: number }> {
      const t0 = Date.now();
      const resp = await this.sendRaw("ping", {}); // existing send() requires CaptureType
      const rttMs = Date.now() - t0;
      // resp shape: { type: "pong", request_id, server_ts }
      return { rttMs, serverTs: (resp as any).server_ts };
    }
    promoteIdea(filepath: string, status: IdeaStatus): Promise<CaptureResponse> {
      return this.sendRaw("capture/idea/promote", { filepath, status });
    }
    ```
  - Refactor `send()` to a private `sendRaw(type: string, payload: object)` that doesn't typecheck against `CaptureType`. Keep the public `send(t: CaptureType, …)` for backward compat.
- **MIRROR**: `client.ts` existing `send()`.
- **IMPORTS**: `IdeaStatus` from `./types.js`.
- **GOTCHA**: `ping` resolves with a non-`CaptureResponse` shape — the public method should hide that and return `{rttMs, serverTs}` only.
- **VALIDATE**: `npm run build:shared` passes. New unit test `ping resolves with rtt + serverTs` (see Phase F).

---

### Phase C — Mobile UX polish (NTH 1, 2, 5, 6) + camera (DEF 1)

#### Task C1: Connection status hook + StatusPill

- **ACTION**: Surface `NavettedClient` status to the UI as a reusable hook + visual pill.
- **IMPLEMENT**:
  - `apps/mobile/src/lib/useConnectionStatus.ts`:
    ```ts
    export function useConnectionStatus(): ConnectionStatus {
      const [status, setStatus] = useState<ConnectionStatus>("disconnected");
      useEffect(() => {
        let active = true;
        void getClient((s) => { if (active) setStatus(s); });
        return () => { active = false; };
      }, []);
      return status;
    }
    ```
  - `apps/mobile/src/components/StatusPill.tsx`: small Paper `Chip` with colour mapping (`connected` → green, `connecting`/`reconnecting` → amber, `error`/`disconnected` → red).
- **MIRROR**: `CaptureScreen.tsx:35-46` (existing in-screen status callback).
- **IMPORTS**: `useState`, `useEffect`, `Chip` from `react-native-paper`.
- **GOTCHA**: Don't double-subscribe — the singleton `getClient` already retains the latest callback. If two screens mount the hook at once, pass each its own callback (current `getClient` overrides; needs a small enhancement: maintain a Set<callback> in `lib/client.ts`).
- **VALIDATE**: Mount on Home, set Settings to a bad token, save → pill turns red within ~30s.

#### Task C2: Mount StatusPill on Home + bump `getClient` to multi-listener

- **ACTION**: Place the pill in `HomeScreen` `headerRight` to the left of the cog; refactor `getClient` to fan out status to multiple subscribers.
- **IMPLEMENT**:
  - `apps/mobile/src/lib/client.ts`: replace the single `onStatus` parameter with a `subscribe(cb)` returning an unsubscribe fn. Internally hold a `Set<cb>` and broadcast every status change.
  - `HomeScreen.tsx` `useLayoutEffect`: render `<StatusPill />` next to `<IconButton icon="cog" />`.
- **MIRROR**: `HomeScreen.tsx:21-30`.
- **IMPORTS**: `StatusPill`, `useConnectionStatus`.
- **GOTCHA**: Existing `CaptureScreen` calls `getClient(setStatus)`. The refactor must preserve that ergonomic — make `getClient(cb)` register `cb` as a subscriber.
- **VALIDATE**: Both Home and Capture display the same status simultaneously.

#### Task C3: Settings — "Tester la connexion" button

- **ACTION**: Add a button beneath the form that calls `client.ping()` and reports rtt or error.
- **IMPLEMENT**: In `SettingsScreen.tsx`, before the "Enregistrer" button:
  ```tsx
  <Button mode="outlined" onPress={async () => {
    setTesting(true); setTestResult(null);
    try {
      const c = await getClient();
      const { rttMs } = await c.ping();
      setTestResult({ ok: true, msg: `Connecté en ${rttMs}ms` });
    } catch (e: unknown) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally { setTesting(false); }
  }} loading={testing}>Tester la connexion</Button>
  {testResult && <HelperText type={testResult.ok ? "info" : "error"}>{testResult.msg}</HelperText>}
  ```
- **MIRROR**: `SettingsScreen.tsx` `save()` flow.
- **IMPORTS**: `Button`, `HelperText` (already imported).
- **GOTCHA**: The user might tap test before saving — use the *current form* state, not persisted settings, by temporarily building a one-shot `NavettedClient` rather than reusing the singleton.
- **VALIDATE**: Wrong token → red HelperText with "rejected: bad hmac" within ~1s. Right token → green "Connecté en NNNms".

#### Task C4: Idea status promote chips on preview

- **ACTION**: When `phase === "preview"` AND `mode === "idea"`, render three Paper `Chip`s ("Seedling" / "Developing" / "Mature"). Tapping calls `client.promoteIdea(filepath, status)`, refreshes preview.
- **IMPLEMENT**: In `CaptureScreen.tsx`, inside the `<Card.Content>`:
  ```tsx
  {mode === "idea" && response?.filepath && (
    <View style={styles.statusRow}>
      {(["seedling","developing","mature"] as const).map((s) => (
        <Chip key={s} selected={currentStatus === s}
              onPress={async () => {
                const updated = await (await getClient()).promoteIdea(response.filepath!, s);
                setResponse(updated);
              }}>
          {s}
        </Chip>
      ))}
    </View>
  )}
  ```
  Add helper `currentStatus = parseStatus(response.preview_markdown)`.
- **MIRROR**: Existing preview Card in `CaptureScreen.tsx:140-155`.
- **IMPORTS**: `Chip`.
- **GOTCHA**: After promote, the markdown changes — re-derive `currentStatus` from the new preview.
- **VALIDATE**: Capture an idea, tap "developing", re-open the Obsidian file → frontmatter `status: developing`.

#### Task C5: OmniRoute UX — guide manual entry

- **ACTION**: Replace the `PersonInput` "non implémenté" message with a friendlier one when OmniRoute URL is empty.
- **IMPLEMENT**: In `CaptureScreen.tsx` `PersonInput.captureCard()`, on the `if (!settings.omniRouteUrl.trim())` branch, set a `HelperText` of type `info` (not error): "Saisis le texte de la carte ci-dessous, puis Envoyer."
- **MIRROR**: Existing branch in `CaptureScreen.tsx:251-259`.
- **GOTCHA**: Don't unconditionally show this — only when the user explicitly tapped the camera button.
- **VALIDATE**: With OmniRoute URL blank, tap the button → info banner. Type OCR text → submit succeeds.

#### Task C6: Camera capture pipeline (DEF 1)

- **ACTION**: Replace the stub branch with a real CameraView modal that captures, encodes base64, sends to OmniRoute.
- **IMPLEMENT**:
  - New `apps/mobile/src/components/CardScannerModal.tsx`:
    ```tsx
    interface Props { visible: boolean; onResult: (text: string) => void; onClose: () => void; }
    export function CardScannerModal({ visible, onResult, onClose }: Props) {
      const cameraRef = useRef<CameraView>(null);
      const [busy, setBusy] = useState(false);
      const capture = async () => {
        if (!cameraRef.current) return;
        setBusy(true);
        try {
          const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.6 });
          const { omniRouteUrl } = await getSettings();
          const { text } = await ocrBusinessCard(omniRouteUrl, photo.base64!);
          onResult(text);
        } finally { setBusy(false); onClose(); }
      };
      return (
        <Modal visible={visible} onDismiss={onClose}>
          <CameraView ref={cameraRef} style={{flex:1}} facing="back" />
          <Button onPress={capture} loading={busy}>Capturer</Button>
        </Modal>
      );
    }
    ```
  - In `CaptureScreen.tsx` `PersonInput`, replace the camera-disabled branch with `setShowScanner(true)`.
- **MIRROR**: `navette/mobile/src/components/VoiceButton.tsx` for permission-grant pattern; `navette/mobile/src/screens/Connect.tsx` for the CameraView shape.
- **IMPORTS**: `CameraView` from `expo-camera`, `Modal` from `react-native-paper`.
- **GOTCHA**: The OmniRoute response time is variable — show a spinner inside the modal during the OCR roundtrip. If `omniRouteUrl` is blank, short-circuit before opening the camera.
- **VALIDATE**: Real device — capture a card → OCR text appears in the form → submit → person note created.

---

### Phase D — QR pairing (DEF 3)

#### Task D1: Port navette's QR scan flow

- **ACTION**: Read `navette/mobile/src/screens/Connect.tsx`, lift the QR scan + payload-decode logic into `apps/mobile/src/components/QrScanner.tsx`.
- **IMPLEMENT**:
  - `QrScanner.tsx`: presentational — props `{ onPairing(payload: PairingPayload) }`. Internally uses `expo-camera` `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` and `onBarcodeScanned`.
  - Decode: strip `navette://` prefix, base64-decode, JSON.parse → `{host, port, token, tls}` → emit pairing payload.
- **MIRROR**: `navette/mobile/src/screens/Connect.tsx` (READ FIRST — note its actual structure).
- **IMPORTS**: `CameraView`, `useCameraPermissions`, `decode` from `js-base64` (or polyfill via `Buffer`).
- **GOTCHA**: `atob` is not available in React Native's runtime. Use `Buffer.from(b64, 'base64').toString()` or add `js-base64`.
- **VALIDATE**: Open with a freshly-generated `navetted --pair` QR; `onPairing` fires with correct fields.

#### Task D2: PairScreen + first-launch redirect

- **ACTION**: New screen wired to QrScanner that writes settings + clientId on success and pops back to Home.
- **IMPLEMENT**:
  - `apps/mobile/src/screens/PairScreen.tsx`:
    ```tsx
    export default function PairScreen({ navigation }: Props) {
      const handle = async (p: PairingPayload) => {
        const url = `${p.tls ? 'wss' : 'ws'}://${p.host}:${p.port}`;
        const cur = await getSettings();
        await saveSettings({ ...cur, navettedUrl: url, navettedToken: p.token });
        disconnectClient();
        navigation.replace('Home');
      };
      return <QrScanner onPairing={handle} />;
    }
    ```
  - `App.tsx`: add `Pair` route. Before rendering Stack, do a one-shot check on app boot: if `getSettings()` returns the default URL AND empty token, set `initialRouteName="Pair"`.
- **MIRROR**: navette's `Connect.tsx` for layout cues.
- **IMPORTS**: `QrScanner`, `getSettings`, `saveSettings`, `disconnectClient`.
- **GOTCHA**: Don't make pairing mandatory — Settings is still reachable as a fallback. Add a "Saisir manuellement" link in PairScreen that pops to Settings.
- **VALIDATE**: Fresh install (`AsyncStorage.clear()` in dev) → app boots into PairScreen; scanning the navetted QR populates settings and lands on Home connected.

---

### Phase E — Desktop business logic (DEF 2)

#### Task E1: Router + storage + client singleton

- **ACTION**: Mirror the mobile shape in `apps/desktop/src/`.
- **IMPLEMENT**:
  - `apps/desktop/package.json`: add `@carnet/shared` and `react-router-dom@^6`.
  - `apps/desktop/src/lib/client.ts`: identical to mobile but reads/writes `localStorage` (Tauri webview supports it).
  - `apps/desktop/src/lib/storage.ts`: same interface as mobile, localStorage-backed.
  - `apps/desktop/src/App.tsx`: wrap in `BrowserRouter`, three routes (`/`, `/capture/:mode`, `/settings`).
- **MIRROR**: `apps/mobile/src/lib/client.ts`, `storage.ts`. Same exports, swap AsyncStorage for localStorage.
- **IMPORTS**: `react-router-dom`.
- **GOTCHA**: localStorage's quota is fine for 5 captures. Don't try to share a single `lib/` between mobile and desktop — RN and web have incompatible storage APIs.
- **VALIDATE**: `npm run desktop:tauri` opens the window with three routes navigable via header buttons.

#### Task E2: Desktop screens (Home, Capture, Settings)

- **ACTION**: Three thin React components, no Paper (use plain CSS).
- **IMPLEMENT**:
  - `HomeScreen`: three `<a>` buttons → `/capture/idea`, `/capture/journal`, `/capture/person`. List recent captures from storage.
  - `CaptureScreen`: read `:mode` param. Idea & journal: textarea + submit. Person: textarea for OCR text + textarea for context + submit. NO voice/camera on desktop MVP.
  - `SettingsScreen`: three `<input>`s (URL/token/OmniRoute) + "Tester la connexion" button (uses `client.ping()`).
- **MIRROR**: Mobile screens — reuse the `deriveTitle`, `recordCapture` helpers verbatim where possible.
- **IMPORTS**: hooks + react-router.
- **GOTCHA**: Tauri's CSP in `tauri.conf.json` already allows `connect-src 'self' ws: wss:` — that's needed for the WebSocket. Don't tighten it.
- **VALIDATE**: End-to-end on the desktop: type idea → submit → file appears in sync_folder.

---

### Phase F — Tests (DEF 4)

#### Task F1: Vitest scaffolding for `@carnet/shared`

- **ACTION**: Add Vitest + write `client.test.ts` covering the request-id correlation + status callbacks.
- **IMPLEMENT**:
  - `packages/shared/package.json`: add `"test": "vitest run"`, `vitest`, `jsdom`.
  - `packages/shared/vitest.config.ts`: `{ test: { environment: 'node' } }` — node env is fine; we mock `WebSocket` directly.
  - `packages/shared/src/client.test.ts`: stub WebSocket via a minimal mock class, drive the handshake, assert that `captureIdea` resolves with the matching `request_id`.
- **MIRROR**: `navette/desktop/vitest.config.ts` (existing in navette repo).
- **GOTCHA**: jsdom is overkill for a non-DOM library; node env keeps tests fast. `WebSocket` in node 22 has a native polyfill but the test should still inject a stub for determinism.
- **VALIDATE**: `npm -w @carnet/shared test` — all tests pass.

#### Task F2: Rust tests for the new daemon endpoints

- **ACTION**: Tests for `promote_idea`, the timestamped journal append, idea collision suffix, Unicode slug.
- **IMPLEMENT**: Extend the existing `#[cfg(test)] mod tests` block in `navette/src/capture/handlers.rs`. Each test creates a tempdir under `std::env::temp_dir()`, exercises the function, asserts file contents.
- **MIRROR**: `navette/src/config.rs` `tls_enabled_when_files_exist` for tempdir setup pattern.
- **IMPORTS**: `tempfile` is already a dev-dependency.
- **GOTCHA**: `handle_idea` calls `run_claude` — we can't unit-test the full handler without mocking the subprocess. Test the *helpers* (slugify, rewrite_frontmatter_field, journal-append branch isolated as a fn) instead.
- **VALIDATE**: `cargo test --package navetted` — all green.

#### Task F3: Mobile component smoke tests (optional this round)

- **ACTION**: One smoke test per screen rendering with a mocked `getClient`.
- **IMPLEMENT**: `@testing-library/react-native` + `jest-expo`. Or skip if scope tight — tests on RN are heavy.
- **GOTCHA**: This task is the most expensive; if time-boxed, defer.
- **VALIDATE**: `npm -w @carnet/mobile test` runs.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `slugify("Mémoire")` | `"Mémoire"` | `"memoire"` | Yes — Unicode |
| `slugify("中文")` | `"中文"` | `""` (then handler falls back to `"untitled"`) | Yes — non-Latin |
| `journal append at 14:32` | existing file + new md | result contains `## 14:32` | Yes — same-day repeat |
| `idea collision` | pre-existing `test.md` | new file `test-2.md` | Yes — duplicate slug |
| `promote_idea("seedling" → "developing")` | fixture file | rewritten frontmatter | Yes — happy path |
| `promote_idea(invalid status)` | `"foo"` | error | Yes — input validation |
| `client.ping()` | mock server replies pong | `{rttMs > 0, serverTs}` | No |
| `client.captureIdea` correlates request_id | two parallel calls | each resolves with its own response | Yes — concurrency |
| `useConnectionStatus` reflects live status | mock client transitions | hook returns latest status | No |

### Edge Cases Checklist

- [ ] Empty title in idea (slug fallback to `"untitled"`)
- [ ] 100+ ideas with the same slug (collision cap → error, not infinite loop)
- [ ] Journal capture when `Journal/` directory doesn't yet exist
- [ ] `promote_idea` on a file with no frontmatter (reject with informative error)
- [ ] `promote_idea` on a file with `status:` already at the target value (idempotent)
- [ ] Camera permission denied (modal closes with HelperText)
- [ ] OmniRoute returns 500 (modal shows error, no person note created)
- [ ] QR payload base64 with embedded newlines (most QR libs strip; verify)
- [ ] Settings test connection while disconnected (button stays usable)
- [ ] Pair flow scanning a non-`navette://` QR (silent ignore + visible "Code non reconnu" hint)
- [ ] Multiple StatusPill subscribers (no duplicate websockets)

---

## Validation Commands

### Static Analysis

```bash
# Rust side
cd /home/user/Documents/vibe-code/navette && cargo check --all-targets
```
EXPECT: zero warnings, zero errors (matches current MVP baseline).

```bash
# TypeScript side
cd /home/user/Documents/vibe-code/carnet
npm run build:shared
npx --workspace @carnet/mobile tsc --noEmit
npx --workspace @carnet/desktop tsc --noEmit
```
EXPECT: no errors.

### Unit Tests

```bash
# Rust
cd /home/user/Documents/vibe-code/navette && cargo test --package navetted
```
EXPECT: all `capture::handlers::tests::*` pass.

```bash
# Shared TS
cd /home/user/Documents/vibe-code/carnet && npm -w @carnet/shared test
```
EXPECT: all client tests pass.

### Manual Validation

- [ ] Fresh install on a phone → boots into PairScreen → scan navetted QR → lands on Home with green status pill.
- [ ] Capture an idea → preview shows three status chips → tap "developing" → reopen file in Obsidian → frontmatter `status: developing`.
- [ ] Capture two journal entries on the same day → file contains both, second prefixed with `## HH:MM` heading.
- [ ] Capture idea with title "Mémoire & flux" → file lands at `Ideas/memoire-flux.md` (or `-2.md` on collision).
- [ ] Configure OmniRoute, person mode → tap Scanner → photo + OCR populate the form.
- [ ] No OmniRoute → tap Scanner → friendly info banner; manual paste still works.
- [ ] Settings: change token to garbage → tap "Tester la connexion" → red "rejected: bad hmac".
- [ ] Settings: change back to good token → green "Connecté en NNNms".
- [ ] Open desktop app → same three modes (no voice/camera) → idea capture writes the same file.

---

## Acceptance Criteria

- [ ] Phase A: navette `cargo check` + `cargo test` clean; new tests for slug/append/collision/promote pass.
- [ ] Phase B: `npm run build:shared` clean; `client.test.ts` passes; `ping()` and `promoteIdea()` exported from `@carnet/shared`.
- [ ] Phase C: Home shows StatusPill; Settings has working "Tester la connexion"; idea preview has status chips; person camera modal captures + OCRs; manual entry path still works when OmniRoute is unset.
- [ ] Phase D: Fresh install boots into PairScreen; QR scan populates settings and connects automatically; manual fallback still reachable.
- [ ] Phase E: Desktop has Home/Capture/Settings; idea + journal text capture works end-to-end; settings persist across app restarts.
- [ ] Phase F: Vitest passes for `@carnet/shared`; new Rust tests pass.

## Completion Checklist

- [ ] All TODO.md items marked complete except KIs (KI items remain — separate plan).
- [ ] `cargo check --all-targets` clean
- [ ] `npm run build:shared` clean
- [ ] Mobile + desktop `tsc --noEmit` clean
- [ ] No new lint warnings
- [ ] `TODO.md` updated to reflect completed items
- [ ] No hardcoded values; all config still reads from settings/Config
- [ ] French strings consistent with existing inline copy
- [ ] No unintended dependencies added (only `deunicode`, `vitest`, `react-router-dom`, `js-base64` if needed)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `getClient` multi-listener refactor breaks `CaptureScreen`'s status callback | Medium | Low | Keep the old single-cb signature as a thin wrapper around `subscribe()` |
| `expo-camera` permission denial leaves modal stuck | Low | Medium | Modal renders `HelperText` + auto-closes on permission denied path |
| QR base64 decoding differs between iOS/Android RN runtimes | Low | High | Use `js-base64` (battle-tested) instead of `atob`/`Buffer` |
| `deunicode` produces unexpected slugs for emoji/symbols | Low | Low | Existing ASCII-filter loop already strips garbage; tests cover it |
| Tauri webview's localStorage doesn't persist across app updates | Low | Medium | Tauri 2 + WebKit/WebView2 both persist by default; verify on first release |
| `promote_idea` race condition (file edited externally between read and write) | Low | Low | Atomic write via tmp+rename already in place; user is single-author by design |

## Notes

- Order matters: B before C (Settings test button uses `ping()`); A before C4 (status chips use `promoteIdea`); D and E can land in parallel after C.
- KI #1 (secure token storage), KI #2 (decoupled WS read loop), KI #3 (daemon timeout) are explicitly out of scope per user request — track separately if/when planned.
- All file:line references valid as of this commit. If implementing later, run a `grep` to confirm — tests, refactors, or merges may have shifted line numbers.
- A single PR per phase is the recommended split. Each phase compiles + ships independently.
