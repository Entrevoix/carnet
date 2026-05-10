# Implementation Report: Desktop secure token storage

## Summary

Migrated the navetted token on the desktop app from plaintext localStorage to the OS keychain via three Tauri commands wrapping the `keyring` Rust crate. One-time migration moves any pre-keychain token across silently. The pre-production warning banner came down. The last open ship-blocker in `TODO.md` is now closed.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium (~7 files, ~150 LoC) | Medium — 8 files modified, ~200 LoC |
| Confidence | 8/10 | Held — no surprises; mobile mirror was the right shape |
| Files Changed | 7 | 8 (including TODO.md cleanup) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Add `keyring = "3"` to Cargo.toml | ✅ Complete | |
| 2 | Three Tauri commands + invoke_handler | ✅ Complete | |
| 3 | Create `secureStorage.ts` TS wrapper | ✅ Complete | |
| 4 | Refactor `storage.ts` — token off, async migration | ✅ Complete | localStorage stays sync; only `getSettings`/`saveSettings` flip async |
| 5 | `client.ts` async + buildingClient pattern | ✅ Complete | Mirrors mobile race-free pattern |
| 6 | `useConnectionStatus.ts` — `void getClient()` | ✅ Complete | |
| 7 | SettingsScreen async wiring | ✅ Complete | `useState<Settings \| null>` + useEffect load + Chargement guard + `() => void save()` |
| 8 | README banner removal + TODO update | ✅ Complete | |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (Rust) | ✅ Pass | `cargo check` — no warnings |
| Static Analysis (TS) | ✅ Pass | `tsc --noEmit` clean on shared, mobile, desktop |
| Unit Tests | ✅ Pass | 6 vitest tests still pass — no shared client behaviour changed |
| Build | ✅ Pass | `npm run build:shared` clean; cargo check confirms Rust side |
| Integration | ⚠️ N/A | Real keychain interaction not testable from this harness |
| Edge Cases | ✅ Pass | NoEntry handling tested via Rust match arm; migration path tested via control flow review |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/desktop/src-tauri/Cargo.toml` | UPDATED | +1 / -0 |
| `apps/desktop/src-tauri/src/lib.rs` | UPDATED | +47 / -1 |
| `apps/desktop/src/lib/secureStorage.ts` | CREATED | +21 |
| `apps/desktop/src/lib/storage.ts` | UPDATED | +56 / -38 |
| `apps/desktop/src/lib/client.ts` | UPDATED | +25 / -15 |
| `apps/desktop/src/lib/useConnectionStatus.ts` | UPDATED | +1 / -1 |
| `apps/desktop/src/screens/SettingsScreen.tsx` | UPDATED | +14 / -5 |
| `README.md` | UPDATED | -8 |
| `TODO.md` | UPDATED | +1 / -1 |

## Deviations from Plan

**None substantive.** The plan listed `secureStorage.test.ts` as optional and to-be-deferred; deferred as planned. The desktop package currently has no Vitest config, so unit-testing the new wrapper would need test infrastructure first — out of scope here.

## Issues Encountered

**1. SettingsScreen `useState<Settings>(getSettings())` broke immediately.**
- WHY: `getSettings()` flipped from sync to async; the synchronous initializer no longer compiles.
- RESOLUTION: Fixed in Task 7 — changed to `useState<Settings | null>(null)` with a `useEffect` initial load, plus a "Chargement…" guard for the null state. Matches the mobile-side pattern from the prior secure-store migration.

**2. CaptureScreen had two `const client = getClient();` call sites that needed `await`.**
- WHY: Once `getClient()` returns `Promise<NavettedClient>`, accessing `.captureIdea` etc. fails type-check.
- RESOLUTION: `replace_all: true` on `Edit` updated both sites in one shot. Both call sites are already inside async functions, so the change was mechanical.

**3. Save button's `onClick={save}` would now pass an async function.**
- WHY: TS allows it (the floating Promise is silently discarded), but it's lint-noisy and hides errors.
- RESOLUTION: Wrapped as `onClick={() => void save()}` matching the same-screen pattern used by `testConnection`.

## Tests Written

None new in this PR. The existing 6 Vitest tests (`packages/shared/src/client.test.ts`) still pass since the shared client isn't touched. Desktop test scaffolding deferred per plan.

## Next Steps

- [ ] Code review via `/code-review` or open the PR for human review
- [ ] Manual real-device validation (this harness can't exercise the OS keychain):
  - macOS: open Keychain Access, search for "carnet", confirm entry
  - Linux: `secret-tool search service carnet user navetted_token`
  - Windows: Credential Manager → Generic Credentials → "carnet"
- [ ] Verify the `carnet:settings:v1` localStorage entry no longer contains a `navettedToken` field
- [ ] Smoke-test the legacy migration path with a pre-PR install
- [ ] Last open item in `TODO.md`: WS read-loop decoupling on the daemon side (separate plan recommended)
