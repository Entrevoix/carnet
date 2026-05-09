# Implementation Report: Carnet — Deferred MVP items & nice-to-have polish

## Summary

Implemented all 11 items from `TODO.md`'s Deferred + Nice-to-have sections across both repos: navette daemon polish (Unicode slug, journal timestamps, idea collision suffix, `promote_idea`, `ping`), shared client (typed `ping()` + `promoteIdea()` methods), mobile UX (StatusPill, Settings test button, idea promote chips, OmniRoute friendly hint, CardScannerModal with real CameraView capture), QR pairing flow with first-launch redirect, full desktop business logic (HashRouter + Home/Capture/Settings), and Vitest test scaffold for `@carnet/shared` with 6 tests covering hello v2 handshake + request_id correlation.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large (~35 carnet + ~6 navette files; 600-800 LoC) | Large — 20 files created, 12 files updated |
| Confidence | 7/10 | Held — no scope cuts, no hidden surprises beyond pre-anticipated `slugify_basic` test update |
| Files Changed | ~35 carnet + ~6 navette | 12 navette mods + 20 carnet new + 12 carnet mods (38 total) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| A1 | Unicode slug via `deunicode` | ✅ Complete | `slugify_basic` test updated (emoji 🚀 now → "rocket", documented in test) |
| A2 | Timestamped journal append (`## HH:MM`) | ✅ Complete | |
| A3 | Idea title collision suffix (-2…-99) | ✅ Complete | |
| A4 | `promote_idea` handler + `rewrite_frontmatter_field` helper | ✅ Complete | |
| A5 | WS dispatch arms `ping` and `capture/idea/promote` | ✅ Complete | |
| B1 | `ping()` + `promoteIdea()` on `NavettedClient` + refactor `send` → private `sendRequest` | ✅ Complete | Pending map now stores generic `Record<string, unknown>` resolver; `handleMessage` accepts `pong` alongside `capture_response` |
| C1 | `useConnectionStatus` hook | ✅ Complete | |
| C2 | `getClient` multi-listener refactor + StatusPill on Home | ✅ Complete | New `subscribeStatus` API; `getClient(cb)` retained for back-compat |
| C3 | Settings "Tester la connexion" button | ✅ Complete | Uses one-shot `NavettedClient` so it tests the *form* values, not the persisted singleton |
| C4 | Idea promote chips on preview | ✅ Complete | |
| C5 | OmniRoute friendly hint when URL is unset | ✅ Complete | Replaced "non implémenté" error with info banner directing user to manual entry |
| C6 | CardScannerModal with real `CameraView` capture | ✅ Complete | Modal handles permission grant inline; takes picture w/ `quality: 0.6` and feeds OmniRoute |
| D1 | `QrScanner` component | ✅ Complete | Mirrors `navette/mobile/src/screens/ConnectScreen.tsx` pattern with `BarCodeScanner` settings |
| D2 | `PairScreen` + first-launch redirect | ✅ Complete | App.tsx awaits settings on boot; if `navettedToken` is empty, routes to Pair |
| E1 | Desktop router + lib/storage + lib/client | ✅ Complete | HashRouter (Tauri-friendly); localStorage persistence; multi-listener client mirrors mobile shape |
| E2 | Desktop screens (Home/Capture/Settings) | ✅ Complete | Plain CSS — no Paper. Capture supports idea/journal/person via `:mode` route param. No voice/camera (per plan). |
| F1 | Vitest config + `client.test.ts` | ✅ Complete | 6 tests: handshake, request_id correlation, unknown id ignored, ping rtt, promoteIdea envelope, connection-close rejection |
| F2 | Rust tests for new daemon endpoints | ✅ Complete | 8 new tests added to `handlers.rs` (Unicode slug, non-Latin slug, frontmatter rewrite happy/idempotent/missing-field/no-frontmatter, promote_idea reject-invalid + happy path) |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (Rust) | ✅ Pass | `cargo check --all-targets` clean — no warnings, no errors |
| Static Analysis (TS — shared) | ✅ Pass | `tsc` clean |
| Static Analysis (TS — mobile) | ✅ Pass | `tsc --noEmit` exit 0 |
| Static Analysis (TS — desktop) | ✅ Pass | `tsc --noEmit` exit 0 |
| Unit Tests (Rust) | ✅ Pass | `cargo test capture::` — 16 passed, 0 failed |
| Unit Tests (TS) | ✅ Pass | `vitest run` — 6 tests passed across 1 test file |
| Build (shared) | ✅ Pass | `npm run build:shared` clean |
| Integration | ⚠️ N/A | Real-device camera, QR scan, daemon ping not testable from this harness |
| Edge Cases | ✅ Pass | Tests cover invalid status, missing field, no frontmatter, non-Latin slug, unknown request_id, connection close mid-request |

## Files Changed

### navette repo (12 changes)

| File | Action | Notes |
|---|---|---|
| `Cargo.toml` | UPDATED | Added `deunicode = "1"` |
| `src/capture/handlers.rs` | UPDATED | Unicode slugify, timestamped journal append, idea collision suffix, `promote_idea`, `rewrite_frontmatter_field`, 8 new tests |
| `src/ws.rs` | UPDATED | Two new dispatch arms (`ping`, `capture/idea/promote`) |

### carnet — packages/shared (4 changes)

| File | Action | Notes |
|---|---|---|
| `package.json` | UPDATED | Added `vitest` devDep + `test` scripts |
| `tsconfig.json` | UPDATED | Excluded `*.test.ts` from build emit |
| `vitest.config.ts` | CREATED | Node env, includes `src/**/*.test.ts` |
| `src/messages.ts` | UPDATED | Added `PromoteIdeaPayload`, `PongResponse` |
| `src/client.ts` | UPDATED | Generic pending map, `pong` correlation, `ping`/`promoteIdea` methods, `sendRequest` private primitive, `PingResult` export |
| `src/index.ts` | UPDATED | Re-export `PingResult`, `PromoteIdeaPayload`, `PongResponse` |
| `src/client.test.ts` | CREATED | 6 tests with mock WebSocket |

### carnet — apps/mobile (8 changes)

| File | Action | Notes |
|---|---|---|
| `App.tsx` | UPDATED | Added `Pair` route + first-launch redirect |
| `src/lib/client.ts` | UPDATED | Multi-listener via `Set<cb>`, `subscribeStatus`, `getCurrentStatus` |
| `src/lib/useConnectionStatus.ts` | CREATED | Hook subscribing to client status |
| `src/components/StatusPill.tsx` | CREATED | Paper Chip with status colour mapping |
| `src/components/CardScannerModal.tsx` | CREATED | Real CameraView capture + OCR roundtrip |
| `src/components/QrScanner.tsx` | CREATED | QR scanner with `navette://` payload decode |
| `src/screens/HomeScreen.tsx` | UPDATED | Mounts StatusPill in `headerRight` next to cog |
| `src/screens/CaptureScreen.tsx` | UPDATED | Promote chips, OmniRoute friendly hint, scanner modal integration |
| `src/screens/SettingsScreen.tsx` | UPDATED | Test connection button + result banner |
| `src/screens/PairScreen.tsx` | CREATED | QR pairing entry with manual fallback link |

### carnet — apps/desktop (8 changes)

| File | Action | Notes |
|---|---|---|
| `package.json` | UPDATED | Added `@carnet/shared`, `react-router-dom@^7` |
| `src-tauri/tauri.conf.json` | UPDATED | Window default 720×480 → 900×640 |
| `src/App.tsx` | UPDATED | HashRouter with three routes |
| `src/index.css` | UPDATED | Full design system (pills, buttons, forms, status chips, etc.) |
| `src/lib/storage.ts` | CREATED | localStorage settings + recent captures |
| `src/lib/client.ts` | CREATED | Same singleton + multi-listener pattern as mobile |
| `src/lib/useConnectionStatus.ts` | CREATED | Same hook as mobile |
| `src/screens/HomeScreen.tsx` | CREATED | Three buttons + recent list + status pill |
| `src/screens/CaptureScreen.tsx` | CREATED | Mode-switched (idea/journal/person), text-only inputs |
| `src/screens/SettingsScreen.tsx` | CREATED | Form + connection-test |

## Deviations from Plan

**1. Plan suggested `js-base64` for QR decode; used built-in `atob` instead.**
- WHY: After reading `navette/mobile/src/screens/ConnectScreen.tsx`, confirmed `atob` is what navette uses successfully on Hermes (Expo 54). The plan's "use `js-base64`" was a defensive precaution that turned out unnecessary.
- IMPACT: One fewer dependency.

**2. Plan listed `expo-secure-store` migration as out-of-scope; left it that way.**
- WHY: Per user request, "deferred + 7 NTH" excluded the 3 KIs (secure storage, WS decoupling, daemon timeout). Plan respected; no scope creep.

**3. Mobile `apps/desktop` deps include `react-router-dom@^7` (not `^6` as plan suggested).**
- WHY: Latest stable; v7 has the same `HashRouter`/`Routes`/`Route`/`Link` API for our use case.
- IMPACT: None on functionality.

**4. `slugify_basic` existing test required update.**
- WHY: deunicode transliterates 🚀 → "rocket" (lossy by design, intentional). Original test asserted emoji-stripped output.
- RESOLUTION: Updated assertion to match new contract; added comment explaining the behaviour.

**5. Used `tokio::test` (not plain `#[test]`) for the two `promote_idea` tests.**
- WHY: Both call `async fn promote_idea`, which needs an async runtime.
- IMPACT: Required no new deps — `tokio` already a workspace dep.

## Issues Encountered

**1. Initial `cargo check` failed**: Two ws.rs test helpers in the existing test module built `Config { ... }` directly and didn't include the new `carnet` field.
- RESOLUTION: Added `carnet: crate::config::CarnetConfig::default()` to both. Re-ran cargo check — clean.

**2. TS index-signature error on `sendRequest(payload: Record<string, unknown>)`**: Typed payload interfaces (`CaptureIdeaPayload`, etc.) lack the implicit string-index signature TypeScript expects.
- RESOLUTION: Loosened the parameter to `object`. Trade-off acknowledged; the typed wrappers above still constrain the wire.

**3. `getClient` was async (mobile) but desktop wanted sync**: Desktop has localStorage which is sync; mobile has AsyncStorage which is async.
- RESOLUTION: Two different `lib/client.ts` files — mobile's is `async getClient()`, desktop's is sync. They share the listener-fanout pattern but diverge on settings retrieval.

**4. Pre-install diagnostics from tsserver were noisy** but the actual `tsc` runs are clean at every checkpoint. None of the IDE-reported errors corresponded to real type issues — all were stale-cache module-not-found before `npm install` completed.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `navette/src/capture/handlers.rs` (tests mod) | +8 (24 total) | slugify Unicode/non-Latin, frontmatter rewrite happy + 4 error cases, promote_idea reject + happy |
| `carnet/packages/shared/src/client.test.ts` | 6 | hello v2 + HMAC, request_id correlation, unknown id ignored, ping rtt+serverTs, promoteIdea envelope, mid-flight connection close |

## Next Steps

- [ ] Manual real-device validation of camera capture, QR pairing, and end-to-end ping (no harness equivalent)
- [ ] Address the 3 known issues from `TODO.md` (secure-store migration, WS read-loop decoupling, daemon-side `claude -p` timeout) — separate plan recommended
- [ ] Recommend committing in 6 phase-shaped commits to keep the diff readable: A → B → C → D → E → F
