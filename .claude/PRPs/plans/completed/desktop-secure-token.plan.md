# Plan: Desktop secure token storage (OS keychain)

## Summary

Move the navetted token from plaintext localStorage on the desktop app into the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service) via the Rust `keyring` crate exposed as Tauri commands. Mirrors the mobile-side `expo-secure-store` migration that already shipped, including a one-time migration of legacy localStorage tokens. After this lands, the README banner can come down and the desktop ship-blocker is gone.

## User Story

As a Carnet desktop user, I want my navetted token stored in the OS keychain rather than browser localStorage, so that another local process or a stolen disk image can't read my pairing secret.

## Problem → Solution

**Current state**: `apps/desktop/src/lib/storage.ts` writes `navettedToken` as part of the `carnet:settings:v1` JSON blob in `localStorage`. Any code running in the Tauri webview (including third-party scripts if CSP ever loosens) can read it; a backup of the user's profile reveals the token in cleartext.

**Desired state**: Token lives in the OS keychain via three Tauri commands (`get_navetted_token`, `set_navetted_token`, `delete_navetted_token`) that wrap `keyring::Entry`. localStorage holds only non-sensitive fields. One-time migration on first read moves any legacy localStorage token into the keychain and strips it from disk so existing users don't have to re-pair.

## Metadata

- **Complexity**: Medium
- **Source PRD**: `TODO.md` — "Desktop tokens in plaintext localStorage" (open ship-blocker)
- **PRD Phase**: standalone
- **Estimated Files**: ~7

---

## UX Design

Internal change — no user-facing UX transformation. Settings screen flow stays identical: paste token → save → token persists across app restarts. Only the storage location changes.

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| First launch after upgrade | Token in localStorage, app reads it on boot | Token migrated from localStorage → keychain on first read; localStorage stripped of `navettedToken` field | One-time, silent. Existing users don't re-pair. |
| Settings → save with new token | Writes to `localStorage["carnet:settings:v1"]` | Writes URL/OmniRoute to localStorage; token to keychain | |
| Settings → save with empty token | Writes empty string into the JSON | Calls `delete_navetted_token` to clear the keychain entry | |
| App force-quit + relaunch | Token survives via localStorage | Token survives via keychain | Same UX, different backing store |
| User wipes browser data via Tauri devtools | Token gone | Token survives in keychain | Slight UX change — separate "logout" action would now need to call delete explicitly. Not in scope; the Settings save-with-empty-token path covers it. |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0 (critical)** | `apps/mobile/src/lib/settings.ts` | full | Reference implementation of the exact pattern (token-only secure store + legacy migration). Desktop mirrors this shape, swapping `expo-secure-store` for Tauri-invoke calls. |
| **P0** | `apps/desktop/src/lib/storage.ts` | full | The file being refactored. Today: synchronous, all-in-one. After: async, token split out. |
| **P0** | `apps/desktop/src/lib/client.ts` | full | Calls `getSettings()` + `getClientId()` synchronously. Must adapt when storage goes async. |
| **P0** | `apps/desktop/src-tauri/src/lib.rs` | full | Where the new Tauri commands attach. The existing `tauri::Builder::default().setup(...)` chain has no `.invoke_handler()` yet — needs adding. |
| **P1 (important)** | `apps/desktop/src-tauri/Cargo.toml` | full | Where `keyring = "3"` lands. |
| **P1** | `apps/desktop/src/screens/SettingsScreen.tsx` | full | Calls `getSettings()`/`saveSettings()`. Already async-friendly, but verify. |
| **P1** | `apps/desktop/src/screens/CaptureScreen.tsx` | full | Calls `getClient()` → `getSettings()` indirectly. Async cascade lands here. |
| **P1** | `apps/desktop/src/screens/HomeScreen.tsx` | full | Calls `getRecentCaptures()` (no token touch); but `useConnectionStatus()` triggers `getClient()` — verify. |
| **P1** | `apps/desktop/src/lib/useConnectionStatus.ts` | full | Calls `getClient()` synchronously; will need to `void getClient()` then ignore the promise (it's fire-and-forget anyway). |
| **P2 (reference)** | `README.md` | "Pre-production warning" section | Banner to retire once this ships. |
| **P2** | `TODO.md` | "Known issues" section | Mark migration done. |
| **P2** | `apps/desktop/src-tauri/tauri.conf.json` | `app.security.csp` | Verify CSP allows `tauri://` invoke calls (default does). |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `keyring` crate (3.x) | https://docs.rs/keyring/3 | API is `Entry::new(service, user)?.set_password(...) / get_password() / delete_credential()`. Backed by Security.framework on macOS, Credential Manager on Windows, Secret Service / libsecret on Linux. |
| Tauri 2 custom commands | https://v2.tauri.app/develop/calling-rust/ | `#[tauri::command]` async fn → register via `.invoke_handler(tauri::generate_handler![...])`. No capability entries required for app-level commands (only plugins need permissions). |
| Tauri 2 invoke from JS | https://v2.tauri.app/develop/calling-rust/#invoking-from-javascript | `import { invoke } from "@tauri-apps/api/core"; await invoke<string>("my_command", { arg })`. Args are camelCase on JS side, snake_case on Rust side (Tauri converts). |
| Linux runtime requirement | keyring crate README | `libsecret-1-0` package on Debian/Ubuntu; `gnome-keyring` or `kwallet` daemon must be running for the secret-service backend. Expect failure on truly headless Linux. |

KEY_INSIGHT: `keyring::Entry::delete_credential()` is the v3 method name; older docs say `delete_password()`. Verify the version actually pulled.

GOTCHA: On Linux, if no keyring daemon is running, `set_password()` returns an error rather than silently no-op'ing. The TS wrapper must propagate this so the Settings UI can show "Failed to save token to keychain" rather than swallowing.

GOTCHA: Tauri commands defined in `src-tauri/src/lib.rs` get exposed without ACL by default in Tauri 2. If the project later adds strict capability filtering, custom commands need a permission file. Out of scope for this plan but worth knowing.

GOTCHA: `keyring::Entry::new(service, user)` requires both fields. Pick stable values — service `"carnet"`, user `"navetted_token"` — and document them so a future "logout" feature can also clear this entry.

GOTCHA: The CI desktop job (`vite build` only) will keep working without changes. Adding a Tauri Rust build step would require apt-installing `libsecret-1-dev` + `libdbus-1-dev` + the existing `webkit2gtk-4.1` set. Out of scope here.

---

## Patterns to Mirror

### MOBILE_SECURE_STORE_SHAPE
// SOURCE: `apps/mobile/src/lib/settings.ts:1-95` — copy this control flow verbatim, swapping `SecureStore.getItemAsync(TOKEN_KEY)` for `invoke<string|null>("get_navetted_token")`.
```ts
const SETTINGS_KEY = "carnet:settings:v1";
const TOKEN_KEY = "carnet_navetted_token";

interface PersistedSettings {
  navettedUrl: string;
  omniRouteUrl: string;
  navettedToken?: string; // legacy, migrated on first read
}

export async function getSettings(): Promise<Settings> {
  const persisted = await readPersisted();
  let token = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? "";
  if (!token && persisted.navettedToken) {
    token = persisted.navettedToken;
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    await writePersisted(persisted); // strips legacy
  }
  return { navettedUrl: persisted.navettedUrl, omniRouteUrl: persisted.omniRouteUrl, navettedToken: token };
}
```

### TAURI_COMMAND
// SOURCE: Tauri 2 docs (no in-repo example yet — `lib.rs` only has tray setup).
```rust
#[tauri::command]
async fn get_navetted_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("carnet", "navetted_token")
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
```

### TAURI_INVOKE_FROM_JS
// SOURCE: `@tauri-apps/api/core`. Match this shape in `secureStorage.ts`.
```ts
import { invoke } from "@tauri-apps/api/core";
export async function getNavettedToken(): Promise<string | null> {
  return invoke<string | null>("get_navetted_token");
}
```

### MIGRATION_GUARD
// SOURCE: `apps/mobile/src/lib/settings.ts:55-65`
```ts
if (!token && persisted.navettedToken) {
  token = persisted.navettedToken;
  await setNavettedToken(token);
  await writePersisted(persisted); // strips legacy field
}
```
The migration only fires when (a) keychain has nothing AND (b) localStorage has a legacy field. Idempotent across reads.

### ASYNC_STORAGE_SHAPE
// SOURCE: `apps/desktop/src/lib/client.ts` — currently sync. After migration:
```ts
export async function getClient(): Promise<NavettedClient> {
  const settings = await getSettings();
  const clientId = await getClientId();
  // ... rest unchanged
}
```
Mirrors mobile's `getClient()`. Call sites (`CaptureScreen.submit`, `CaptureScreen.promote`, `SettingsScreen.testConnection`) are already inside `async` functions — the cascade is mechanical.

### TEST_STRUCTURE_TS (existing carnet pattern)
// SOURCE: `packages/shared/src/client.test.ts:1-30`
Vitest with `node` env, `mockWebSocket`-style stubs. Same pattern applies for stubbing `invoke` in `secureStorage.test.ts`.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/desktop/src-tauri/Cargo.toml` | UPDATE | Add `keyring = "3"` |
| `apps/desktop/src-tauri/src/lib.rs` | UPDATE | Add three `#[tauri::command]` async fns + `.invoke_handler(...)` on the builder |
| `apps/desktop/src/lib/secureStorage.ts` | CREATE | Thin wrapper around `invoke()` for the three commands |
| `apps/desktop/src/lib/storage.ts` | UPDATE | Split token off to keychain; settings/recent-captures stay in localStorage; one-time migration |
| `apps/desktop/src/lib/client.ts` | UPDATE | `getClient()` becomes `async`; everything else identical |
| `apps/desktop/src/lib/useConnectionStatus.ts` | UPDATE | `void getClient()` instead of bare `getClient()` (unused-promise warning) |
| `apps/desktop/src/screens/SettingsScreen.tsx` | UPDATE | `getSettings()` is now async — wrap initial load in a `useEffect`; `saveSettings()` already async-tolerant |
| `apps/desktop/src/screens/CaptureScreen.tsx` | UPDATE | Verify `getClient()` cascade works (no edits expected — existing usage is in async fns) |
| `README.md` | UPDATE | Drop the desktop pre-production banner; remove the "do not distribute desktop builds" line |
| `TODO.md` | UPDATE | Mark "Desktop tokens in plaintext localStorage" as `[x]` and add this PR's commit hash |
| `apps/desktop/src/lib/secureStorage.test.ts` (optional) | CREATE | Vitest with `invoke` stubbed to verify the wrapper shape — only if the desktop package gains a vitest config; currently it has Playwright + vitest config inherited from navette/desktop pattern but no tests. SKIP for this PR. |

## NOT Building

- **Stronghold-style master-password vault.** Single token doesn't justify the complexity.
- **Token rotation / multi-account.** Carnet is single-tenant; one token at a time.
- **Tauri Rust CI step.** Adds `libsecret-1-dev` + `libdbus-1-dev` + 1-2 min to CI. Not blocking — vite build step still runs.
- **Logout / "forget my pairing" UI.** Settings → empty token → save already calls `delete_navetted_token`. Explicit logout button is separate UX.
- **Encrypted-at-rest fallback for headless Linux.** If the user is running Tauri on a system without a keyring daemon, the app will fail to save the token with a clear error. Acceptable — desktop apps are interactive by definition.
- **Migration TO localStorage if keychain fails.** No fallback layer; surface the error.
- **Mobile changes.** `expo-secure-store` already shipped (PR carnet#1).

---

## Step-by-Step Tasks

### Task 1: Add `keyring` Rust dependency

- **ACTION**: Edit `apps/desktop/src-tauri/Cargo.toml`
- **IMPLEMENT**: Append `keyring = "3"` to the `[dependencies]` block
- **MIRROR**: existing dep list in same file (`tauri = "2"`, `serde = "1"`, etc.)
- **IMPORTS**: N/A (Cargo metadata only)
- **GOTCHA**: Pin the major version to `3`. The 3.x breaking changes from 2.x include `delete_credential` rename. If `cargo update` later jumps to 4.x, expect breakage.
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo check` succeeds.

### Task 2: Add three Tauri commands in `lib.rs`

- **ACTION**: Add `#[tauri::command]` async fns + register via `.invoke_handler(tauri::generate_handler![...])` on the existing `tauri::Builder::default()` chain.
- **IMPLEMENT**:
  ```rust
  const KEYRING_SERVICE: &str = "carnet";
  const KEYRING_USER: &str = "navetted_token";

  #[tauri::command]
  async fn get_navetted_token() -> Result<Option<String>, String> {
      let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
          .map_err(|e| format!("keyring init: {e}"))?;
      match entry.get_password() {
          Ok(pw) => Ok(Some(pw)),
          Err(keyring::Error::NoEntry) => Ok(None),
          Err(e) => Err(format!("keyring read: {e}")),
      }
  }

  #[tauri::command]
  async fn set_navetted_token(token: String) -> Result<(), String> {
      let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
          .map_err(|e| format!("keyring init: {e}"))?;
      entry.set_password(&token).map_err(|e| format!("keyring write: {e}"))
  }

  #[tauri::command]
  async fn delete_navetted_token() -> Result<(), String> {
      let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
          .map_err(|e| format!("keyring init: {e}"))?;
      match entry.delete_credential() {
          Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
          Err(e) => Err(format!("keyring delete: {e}")),
      }
  }
  ```
  Add to the builder chain:
  ```rust
  tauri::Builder::default()
      .invoke_handler(tauri::generate_handler![
          get_navetted_token,
          set_navetted_token,
          delete_navetted_token,
      ])
      .setup(|app| { /* existing tray code */ })
  ```
- **MIRROR**: TAURI_COMMAND pattern above
- **IMPORTS**: `keyring` automatically in scope via Cargo dep; no `use` needed if you fully qualify (`keyring::Entry`, `keyring::Error::NoEntry`).
- **GOTCHA**: `delete_credential` returning `NoEntry` is success-equivalent — never error if the keychain didn't have a value to delete.
- **VALIDATE**: `cd apps/desktop && npm run tauri dev` opens the window and the commands appear in `__TAURI__.invoke()` introspection. (Or skip — task 4's TS wrapper exercises them.)

### Task 3: Create `secureStorage.ts` TS wrapper

- **ACTION**: New file `apps/desktop/src/lib/secureStorage.ts`
- **IMPLEMENT**:
  ```ts
  import { invoke } from "@tauri-apps/api/core";

  export async function getNavettedToken(): Promise<string | null> {
    return invoke<string | null>("get_navetted_token");
  }

  export async function setNavettedToken(token: string): Promise<void> {
    return invoke("set_navetted_token", { token });
  }

  export async function deleteNavettedToken(): Promise<void> {
    return invoke("delete_navetted_token");
  }
  ```
- **MIRROR**: TAURI_INVOKE_FROM_JS pattern above
- **IMPORTS**: `@tauri-apps/api/core` (already in `apps/desktop/package.json`)
- **GOTCHA**: Tauri's invoke layer converts arg names. Rust `token: String` ↔ JS `{ token }`. Match exactly.
- **VALIDATE**: `cd apps/desktop && npx tsc --noEmit` clean.

### Task 4: Refactor `storage.ts` — split token off, async migration

- **ACTION**: Edit `apps/desktop/src/lib/storage.ts`
- **IMPLEMENT**: Mirror `apps/mobile/src/lib/settings.ts` shape exactly, swapping the `expo-secure-store` calls for the new wrappers from Task 3:
  ```ts
  import {
    getNavettedToken,
    setNavettedToken,
    deleteNavettedToken,
  } from "./secureStorage";

  const SETTINGS_KEY = "carnet:settings:v1";
  const CLIENT_ID_KEY = "carnet:client_id:v1";

  interface PersistedSettings {
    navettedUrl: string;
    omniRouteUrl: string;
    navettedToken?: string; // legacy, migrated on first read
  }

  export async function getSettings(): Promise<Settings> {
    const persisted = readPersisted();
    let token = (await getNavettedToken()) ?? "";
    if (!token && persisted.navettedToken) {
      token = persisted.navettedToken;
      await setNavettedToken(token);
      writePersisted({ navettedUrl: persisted.navettedUrl, omniRouteUrl: persisted.omniRouteUrl });
    }
    return { navettedUrl: persisted.navettedUrl, omniRouteUrl: persisted.omniRouteUrl, navettedToken: token };
  }

  export async function saveSettings(settings: Settings): Promise<void> {
    writePersisted({ navettedUrl: settings.navettedUrl, omniRouteUrl: settings.omniRouteUrl });
    if (settings.navettedToken) {
      await setNavettedToken(settings.navettedToken);
    } else {
      await deleteNavettedToken();
    }
  }

  // getClientId, getRecentCaptures, recordCapture remain synchronous on
  // localStorage — no token touch.
  ```
  Keep `readPersisted()` / `writePersisted()` synchronous since localStorage is sync. Only the public `getSettings`/`saveSettings` go async.
- **MIRROR**: MOBILE_SECURE_STORE_SHAPE + MIGRATION_GUARD patterns
- **IMPORTS**: `./secureStorage`
- **GOTCHA**: `recordCapture` and `getClientId` stay sync — only the token boundary is async. Don't make everything async unnecessarily.
- **VALIDATE**: `tsc --noEmit` clean. Manual: open the app with a legacy token in localStorage, verify it's gone after one `getSettings()` call.

### Task 5: Update `client.ts` — `getClient()` async

- **ACTION**: Edit `apps/desktop/src/lib/client.ts`
- **IMPLEMENT**: Change signature from `function getClient(): NavettedClient` to `async function getClient(): Promise<NavettedClient>`. Inside, await `getSettings()` and `getClientId()` (the latter stays sync but harmless to skip). Adopt the race-free `buildingClient` pattern from `apps/mobile/src/lib/client.ts:14-72`:
  ```ts
  let buildingClient: Promise<NavettedClient> | null = null;

  export function getClient(): Promise<NavettedClient> {
    if (buildingClient) return buildingClient;
    buildingClient = buildClient().finally(() => { buildingClient = null; });
    return buildingClient;
  }

  async function buildClient(): Promise<NavettedClient> {
    const settings = await getSettings();
    const clientId = getClientId(); // sync — no token touch
    // ... rest of existing logic
  }
  ```
- **MIRROR**: `apps/mobile/src/lib/client.ts` (already has the buildingClient pattern from the devil's-advocate fix round)
- **IMPORTS**: No new imports
- **GOTCHA**: `subscribeStatus` and `getCurrentStatus` stay sync. Only `getClient()` flips to async.
- **VALIDATE**: `tsc --noEmit` clean. All call sites already inside `async` functions, so no further fixes downstream.

### Task 6: Update `useConnectionStatus.ts` — fire-and-forget `getClient()`

- **ACTION**: Edit `apps/desktop/src/lib/useConnectionStatus.ts`
- **IMPLEMENT**: Change `getClient();` to `void getClient();` so the unused-Promise lint doesn't fire. The hook only cares about `subscribeStatus`'s replay; the connection establishes asynchronously in the background.
  ```ts
  useEffect(() => {
    void getClient();
    const unsubscribe = subscribeStatus(setStatus);
    return unsubscribe;
  }, []);
  ```
- **MIRROR**: `apps/mobile/src/lib/useConnectionStatus.ts` already does this
- **IMPORTS**: No change
- **GOTCHA**: If `getClient()` rejects (settings load failure), the error vanishes silently. Consider a `.catch(console.error)` if you want it logged. Optional.
- **VALIDATE**: `tsc --noEmit` clean. Settings test connection still works.

### Task 7: Verify SettingsScreen async wiring

- **ACTION**: Read `apps/desktop/src/screens/SettingsScreen.tsx` end-to-end and confirm the existing `getSettings()`/`saveSettings()` call sites work with the new async signatures.
- **IMPLEMENT**: Likely zero changes — current code uses:
  ```ts
  const [settings, setSettings] = useState<Settings>(getSettings()); // ❌ sync init
  ```
  This breaks. Fix with `useEffect` initial-load pattern matching mobile's SettingsScreen:
  ```ts
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);
  if (!settings) return <main className="screen"><p>Chargement…</p></main>;
  ```
  And `save` becomes:
  ```ts
  const save = async () => {
    await saveSettings(settings);
    disconnectClient();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  ```
  with the button onClick wrapped: `onClick={() => void save()}`.
- **MIRROR**: `apps/mobile/src/screens/SettingsScreen.tsx` uses this exact pattern post-secure-store migration.
- **IMPORTS**: `useEffect` if not already imported.
- **GOTCHA**: `clientId` initial load is independent — keep its `useEffect` separate or merge.
- **VALIDATE**: `tsc --noEmit` clean. Manual: settings screen renders, can save URL/token/OmniRoute, reload preserves values.

### Task 8: Update README + TODO.md

- **ACTION**: Drop the desktop pre-production banner from `README.md`; mark the migration done in `TODO.md`.
- **IMPLEMENT**:
  - `README.md`: remove the entire "⚠️ Pre-production warning" section (the desktop migration was its only remaining item).
  - `TODO.md`: change `- [ ] **Desktop tokens in plaintext localStorage**` to `- [x]`, append `(landed in PR #N)` once known.
- **MIRROR**: Mobile entry already used this pattern.
- **GOTCHA**: Keep the WS read-loop blocker in TODO — that's still open.
- **VALIDATE**: `cargo check` (navette) still clean if you accidentally touched anything; `tsc` clean.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `getNavettedToken()` returns null when entry missing | freshly-installed app, empty keychain | `null` | ✓ |
| `setNavettedToken(t)` then `getNavettedToken()` | round trip | `t` | No |
| `deleteNavettedToken()` on empty keychain | nothing to delete | resolves OK (no error) | ✓ |
| `getSettings()` migrates legacy token | localStorage has `navettedToken: "abc"`, keychain empty | settings.navettedToken === "abc"; localStorage no longer has `navettedToken`; keychain has it | ✓ — migration path |
| `getSettings()` repeat after migration | localStorage clean, keychain has token | settings.navettedToken === keychain value; no second migration | ✓ — idempotent |
| `saveSettings({...token: ""})` | empty token | `deleteNavettedToken` called; keychain entry gone | ✓ — clear path |
| Settings save → reload app → `getSettings()` | persistence round trip | values match | No |

These would land in `apps/desktop/src/lib/storage.test.ts` and `secureStorage.test.ts` IF the desktop package gains vitest config. As of this plan, desktop has no tests. **Defer test scaffolding to a follow-up PR** — verify manually for now via the smoke-test checklist update.

### Edge Cases Checklist
- [ ] Linux without a keyring daemon (gnome-keyring/kwallet not running) — `set_password` errors; UI surfaces "Failed to save token"
- [ ] User clears localStorage via devtools — token survives in keychain (this is a feature, not a bug)
- [ ] User uninstalls + reinstalls the app — keychain entry still exists; first launch sees it and skips PairScreen-equivalent
- [ ] Maximum token size — keyring backends typically limit to a few KB. navetted tokens are 32 chars, well under. No edge.
- [ ] Concurrent settings save — browser localStorage is sync; keychain calls serialize via Tauri IPC. No race.
- [ ] Permission denied on macOS (user blocks Keychain access) — `get_password` errors; UI surfaces

---

## Validation Commands

### Static Analysis

```bash
# Rust
cd /home/user/Documents/vibe-code/carnet/apps/desktop/src-tauri && cargo check
```
EXPECT: zero errors, zero warnings.

```bash
# TypeScript
cd /home/user/Documents/vibe-code/carnet
npm run build:shared
cd apps/desktop && npx tsc --noEmit
```
EXPECT: zero errors.

### Tauri build smoke

```bash
cd /home/user/Documents/vibe-code/carnet/apps/desktop && npm run tauri build -- --debug
```
EXPECT: builds. Warning: takes 5-10 min on a cold machine; needs Tauri prerequisites + libsecret-1-dev on Linux.

### Manual Validation

- [ ] On Linux: ensure gnome-keyring or kwallet is running (`gnome-keyring-daemon --start --components=secrets` if not).
- [ ] Launch the app: `npm run desktop:tauri`.
- [ ] First-time: open Settings, paste a navetted token, Save. Quit the app.
- [ ] Inspect:
  - macOS: open Keychain Access → search for "carnet" → entry exists with type "application password"
  - Linux: `secret-tool search service carnet user navetted_token` shows the entry
  - Windows: Credential Manager → Generic Credentials → "carnet" entry
- [ ] Inspect localStorage via Tauri devtools (Ctrl+Shift+I) → Application → Storage → Local Storage. The `carnet:settings:v1` JSON should NOT contain a `navettedToken` field.
- [ ] Relaunch the app: token survives, app connects with green pill.
- [ ] Legacy migration path: write `localStorage.setItem("carnet:settings:v1", JSON.stringify({navettedUrl: "ws://x", navettedToken: "legacy", omniRouteUrl: ""}))` via devtools, clear the keychain entry, reload. After one render, verify the keychain has "legacy" and localStorage's blob no longer contains the field.
- [ ] Settings → clear token field → Save → keychain entry gone (re-check via OS tool).

---

## Acceptance Criteria

- [ ] All 8 tasks completed
- [ ] `cargo check` (apps/desktop/src-tauri) clean
- [ ] `tsc --noEmit` (apps/desktop) clean
- [ ] CI green on the PR (existing workflow runs vite build — it doesn't exercise the keychain, but compilation passes)
- [ ] Manual: token round-trips through OS keychain, localStorage no longer holds it
- [ ] README "Pre-production warning" section removed
- [ ] `TODO.md` desktop checkbox flipped to `[x]`

## Completion Checklist

- [ ] Code follows discovered patterns (mobile-secure-store mirror)
- [ ] Error handling propagates keyring errors as `Result<_, String>` to JS
- [ ] No `console.log` in production code
- [ ] No hardcoded values (KEYRING_SERVICE / KEYRING_USER are named consts)
- [ ] Documentation updated (README + TODO)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `keyring` 3.x API differs from expected (e.g. `delete_credential` rename) | Low | Low | Pin to `^3`, run `cargo doc --open keyring` once before coding |
| Linux runtime missing libsecret | Medium (some users) | Medium (token save fails) | Surface error clearly in UI; document prerequisite in `apps/desktop/README.md` |
| CI desktop job needs new system deps | Low | Low | Vite build doesn't exercise Rust at all in current CI; no change needed |
| Migration loop (token-in-localStorage → keychain → forgot to strip) writes on every load | Low | Low | Test covers idempotency; the `if (!token && persisted.navettedToken)` guard is single-fire |
| Tauri command ACL tightens later and breaks invoke | Low | Medium | Document that custom commands need a permission entry under strict ACL; out of scope here |
| User's keychain prompts for permission on every read (macOS) | Low | High UX | Set the entry as "Always allow" for the app on first prompt — user-side fix, document in smoke-test checklist |

## Notes

- The mobile-side migration that already shipped is the playbook. Re-read `apps/mobile/src/lib/settings.ts` before writing the desktop version. The shapes should match closely enough that someone reading both files diagonally can verify correctness.
- After this PR, the only remaining open item in `TODO.md` is the WS read-loop decoupling on the daemon side. That's a navette-only change, plan separately.
- Smoke test checklist (`docs/smoke-test.md`) should pick up two new desktop steps: keychain inspection + localStorage absence verification. Update in this PR or a follow-up.
- Branch suggestion: `feat/desktop-secure-token`. Single PR, ~7 files, mergeable in one go.
