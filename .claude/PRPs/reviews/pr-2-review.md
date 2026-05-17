# PR Review: #2 — feat: store desktop navetted token in OS keychain

**Reviewed**: 2026-05-10
**Author**: bearyjd
**Branch**: feat/desktop-secure-token → main
**Decision**: APPROVE WITH COMMENTS

## Summary

Cleanly mirrors the mobile-side `expo-secure-store` migration: navetted token moves from plaintext localStorage to the OS keychain via three Tauri commands wrapping the `keyring` crate. Code is well-structured, faithfully follows the plan, and all five validation checks pass. A test suite for the migration path landed mid-PR (`storage.test.ts`, 3/3 passing) and `SettingsScreen` now surfaces both load and save errors. Two corner-case findings on top of that — both LOW/MEDIUM, neither blocking.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M1 — Settings fallback on `getSettings` rejection silently discards persisted URL/OmniRoute** (`apps/desktop/src/screens/SettingsScreen.tsx:39-46` + `apps/desktop/src/lib/storage.ts:71-89`)

When `getSettings()` rejects (Linux without a keyring daemon, macOS Keychain access denied), `SettingsScreen` substitutes `FALLBACK_SETTINGS` for the entire settings object — wiping the URL and OmniRoute the user had previously saved in localStorage from the form's perspective. If the user then types a token and hits Save, `saveSettings` writes the *fallback* URL/OmniRoute to localStorage, overwriting the real persisted values. The `readPersisted()` data is recoverable (sync, can't fail) — only the keychain read failed.

Fix options, lightest to heaviest:
- In `storage.ts`, catch the keychain error inside `getSettings()` and resolve with `{ navettedUrl: persisted.navettedUrl, omniRouteUrl: persisted.omniRouteUrl, navettedToken: "" }` plus a side channel (or shape change) so the screen can show the warning without losing the data.
- Export `readPersisted` so `SettingsScreen`'s catch arm can fall back to the *real* persisted URL/OmniRoute instead of `FALLBACK_SETTINGS`.

### LOW

**L1 — Legacy localStorage token can persist if migration is interrupted between keychain write and localStorage strip** (`apps/desktop/src/lib/storage.ts:78-82`)

Migration order:
```ts
await setNavettedToken(token);   // 1. write keychain
writePersisted(persisted);        // 2. strip legacy field (sync)
```
If the process is killed between (1) and (2), the next launch sees a non-null keychain value, skips the migration branch, and never re-strips the legacy `navettedToken` from localStorage — defeating the security guarantee for that user.

Window is microseconds (one synchronous statement after an awaited IPC roundtrip), so the practical risk is low. Cheap defense-in-depth fix:
```ts
const persisted = readPersisted();
if (persisted.navettedToken !== undefined) writePersisted(persisted); // unconditional idempotent strip
let token = (await getNavettedToken()) ?? "";
if (!token && persisted.navettedToken) {
  token = persisted.navettedToken;
  await setNavettedToken(token);
}
```

**L2 — `useConnectionStatus` swallows `getClient()` rejection** (`apps/desktop/src/lib/useConnectionStatus.ts:10`)

`void getClient()` deliberately discards the promise; if the underlying `getSettings()` rejects, the error is dropped (browser logs an unhandled-rejection warning, but no in-app surface). Status pill ends up stuck on "disconnected" with no diagnostic. Plan flagged this as optional; consider `.catch((e) => console.warn("getClient failed", e))` so devtools at least carries the reason.

**L3 — Tauri commands marked `async` but call only synchronous `keyring` methods** (`apps/desktop/src-tauri/src/lib.rs:22-49`)

`keyring::Entry::new`, `get_password`, `set_password`, `delete_credential` are all blocking. `async fn` doesn't make them async — they'll block whichever runtime task picks them up. Tauri's command worker pool tolerates this fine in practice (these run rarely and the OS calls are sub-millisecond), so it's not a bug. If the purity bothers you, `tokio::task::spawn_blocking` is the canonical fix; otherwise plain (non-async) `#[tauri::command]` would also be clearer about the cost.

**L4 — Test coverage misses the empty-token / `delete_navetted_token` path** (`apps/desktop/src/lib/storage.test.ts`)

`saveSettings({...navettedToken: ""})` is the "user clears the token" UX and the only path that exercises `deleteNavettedToken`. The new test file covers migration thoroughly (3/3 passing) but doesn't exercise the delete branch. One additional test would close the gap.

**L5 — Linux keyring daemon prerequisite isn't documented in `apps/desktop/README.md`**

PR body mentions it; main `README.md` doesn't (and there's no `apps/desktop/README.md`). One-liner there or in the existing prerequisites section saves a future contributor a debug session on a fresh Linux box.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| `npm run build:shared` | Pass | |
| `npx tsc --noEmit` (apps/desktop) | Pass | |
| `npm -w @carnet/desktop test` (vitest) | Pass | 3/3 |
| `cargo check` (apps/desktop/src-tauri) | Pass | |
| `npx vite build` (apps/desktop) | Pass | smoke |

## Files Reviewed

| File | Change | Verdict |
|---|---|---|
| `apps/desktop/src-tauri/Cargo.toml` | Modified | OK — `keyring = "3"` pinned |
| `apps/desktop/src-tauri/Cargo.lock` | Added | OK — binary app, expected |
| `apps/desktop/src-tauri/src/lib.rs` | Modified | OK with L3 |
| `apps/desktop/src/lib/secureStorage.ts` | Added | OK |
| `apps/desktop/src/lib/storage.ts` | Modified | OK with L1, M1 root cause |
| `apps/desktop/src/lib/storage.test.ts` | Added | OK with L4 (missing delete-path test) |
| `apps/desktop/src/lib/client.ts` | Modified | OK — buildingClient pattern correct |
| `apps/desktop/src/lib/useConnectionStatus.ts` | Modified | OK with L2 |
| `apps/desktop/src/screens/SettingsScreen.tsx` | Modified | OK with M1 |
| `apps/desktop/src/screens/CaptureScreen.tsx` | Modified | OK |
| `apps/desktop/package.json` | Modified | OK — vitest + jsdom + `test` script |
| `apps/desktop/vitest.config.ts` | Added | OK |
| `.github/workflows/ci.yml` | Modified | OK — desktop test step wired |
| `.gitignore` | Modified | OK — `**/` anchoring fix is correct |
| `README.md` | Modified | OK — pre-prod banner removed |
| `TODO.md` | Modified | OK with L5 (Linux daemon note belongs here or in apps/desktop README) |
| `.claude/PRPs/plans/completed/desktop-secure-token.plan.md` | Added | OK — plan archive |
| `.claude/PRPs/reports/desktop-secure-token-report.md` | Added | OK — implementation report |
| `package-lock.json` | Modified | OK — vitest/jsdom deps |

## Recommendation

**APPROVE WITH COMMENTS.** Goal achieved cleanly, validation green across the board, plan executed faithfully. M1 is a niche partial-failure UX issue worth fixing in a follow-up. L1–L5 are nits / defense-in-depth / docs. None block merge.
