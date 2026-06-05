# Plan: Fix offline-queue persistence — replace broken `expo-sqlite` with AsyncStorage

## Summary
The offline capture queue (`apps/mobile/src/lib/queue.ts`) can't open its database on-device: `SQLite.openDatabaseAsync` throws `java.lang.NoSuchMethodError … expo.modules.kotlin.sharedobjects.SharedRef` because `expo-sqlite@55.0.16` is an **Expo SDK 55** package linked into an **SDK 54** app (the SDK-54-correct version is `~16.0.10`). Rather than wrangle native versions, swap the queue's storage layer from `expo-sqlite` to **AsyncStorage** — whose native module is already present and working (used by `storage.ts`, `settings.ts`, `VoiceButton`). This is a **JS-only fix** (no `prebuild`, no native recompile), it removes the fragile native dependency from the queue path, and it mirrors the existing `storage.ts` list-persistence pattern.

## User Story
As a carnet user capturing while offline (OmniRoute unreachable), I want my capture saved to a local queue and auto-synced when I reconnect, so I never lose a note to a network blip.

## Problem → Solution
`SQLite.openDatabaseAsync("carnet_queue.db")` rejects on-device with a `SharedRef` ABI error → `enqueue()` throws → the capture shows a red `"Couldn't reach OmniRoute, and queuing offline failed: …"` error and nothing is persisted. **→** Back the queue with AsyncStorage (a JSON array under one key, like `storage.ts`) → offline captures persist (`"Offline — capture queued."`) and drain on next reconnect/foreground.

## Metadata
- **Complexity**: Medium (storage-layer rewrite of one stateful module + test re-mock; concurrency to handle)
- **Source PRD**: N/A (free-form / backlog bug)
- **PRD Phase**: N/A
- **Estimated Files**: 2 (`queue.ts`, `queue.test.ts`); `package.json` only in the optional cleanup follow-up

---

## UX Design

### Before
```
Offline capture → enqueue() → SQLite.openDatabaseAsync throws (SharedRef)
  → red error: "Couldn't reach OmniRoute, and queuing offline failed:
     Call to function 'NativeDatabase.constructor' has been rejected…"
  → capture NOT saved; typed text stuck in the input box
```

### After
```
Offline capture → enqueue() → AsyncStorage append → "Offline — capture queued."
  → reconnect / app foreground → drainQueue() → enrich + write file → row removed
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Capture while offline | Red SQLite error, nothing saved | "Offline — capture queued." | The actual bug fix |
| Reconnect / reopen | (nothing to drain — never queued) | Queued captures enrich + write to disk | `drainQueue()` already wired on CaptureScreen mount |
| Queue depth badge | Always 0 (DB never opened) | Real pending count | `getQueueDepth()` now returns real data |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/queue.ts` | 1–230 | The module being rewritten — keep ALL logic (drain, classify, single-flight, redaction), swap only storage |
| P0 | `apps/mobile/src/lib/storage.ts` | 1–78 | **The pattern to mirror**: JSON array under an AsyncStorage key with read-modify-write helpers (`getRecentCaptures`/`recordCapture`/`removeFromHistory`/`updateCaptureTitle`) |
| P0 | `apps/mobile/src/lib/storage.test.ts` | 1–45 | **The test pattern to mirror**: in-memory `Map` mock of `@react-native-async-storage/async-storage` (`default: { getItem, setItem, removeItem }`) |
| P1 | `apps/mobile/src/lib/queue.test.ts` | 1–290 | Existing test cases to preserve; replace the `expo-sqlite` mock (line 52) with the AsyncStorage mock |
| P1 | `apps/mobile/src/screens/CaptureScreen.tsx` | 107–151, 172–196 | Consumers: `enqueue`, `drainQueue`, `getQueueDepth` and the offline error UI (`handleCaptureError`) — confirm the public API is unchanged |
| P2 | `apps/mobile/src/lib/omniroute.ts` | `isPermanentError` | Error classification used by `drainQueue` (unchanged) |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Expo SDK 54 ↔ package versions | `npx expo install --check` (run 2026-06-04) | SDK 54 wants `expo-sqlite@~16.0.10`; the installed `@55.0.16` is the SDK-55 line → ABI mismatch. (Also skewed: `react-native-worklets`, `babel-preset-expo`, `typescript` — out of scope.) |
| AsyncStorage limits | react-native-async-storage docs | Per-key value soft-limit is generous (MBs); queue holds only small text payloads (idea/journal/person) — never binaries. Fine. |

---

## Patterns to Mirror

### LIST_PERSISTENCE (AsyncStorage JSON array + RMW)
```ts
// SOURCE: apps/mobile/src/lib/storage.ts:1-39
import AsyncStorage from "@react-native-async-storage/async-storage";
const HISTORY_KEY = "carnet:history:v1";
export async function getRecentCaptures(): Promise<CaptureEntry[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try { const p = JSON.parse(raw) as CaptureEntry[]; return Array.isArray(p) ? p : []; }
  catch { return []; }
}
export async function recordCapture(entry: CaptureEntry): Promise<void> {
  const existing = await getRecentCaptures();
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...existing].slice(0, HISTORY_LIMIT)));
}
```

### IN_MEMORY_ASYNCSTORAGE_MOCK (test)
```ts
// SOURCE: apps/mobile/src/lib/storage.test.ts:5-22
const _store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { _store.set(k, v); }),
    removeItem: vi.fn(async (k: string) => { _store.delete(k); }),
  },
}));
```

### KEEP_THESE (existing queue logic — do NOT change)
```ts
// SOURCE: apps/mobile/src/lib/queue.ts
// - sanitizeError() (32-37): Bearer/Authorization redaction before persist
// - single-flight drain guard: let _draining (80) + if (_draining) return (143)
// - error classify: isPermanentError(e) ? PERMANENT_FAILURE_ATTEMPTS : row.attempts+1 (171)
// - localId() (113): non-crypto id (uuid v11 crypto gap — see PR #24)
// - processRow() (188-208): enrich + write, unchanged
```

### NAMING / KEY
- New key: `const QUEUE_KEY = "carnet:queue:v1";` (mirror `storage.ts`'s `carnet:history:v1`).
- Keep the `QueueRow` shape **exactly** (`id, mode, payload_json, created_at, attempts, last_error`) so `drainQueue`/`getAllQueueRows`/types and the test assertions (`JSON.parse(row.payload_json)`) are untouched — only the backend changes.

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/queue.ts` | UPDATE | Replace `expo-sqlite` storage primitives with AsyncStorage RMW helpers + a mutation lock; keep all queue logic + public API |
| `apps/mobile/src/lib/queue.test.ts` | UPDATE | Swap the `expo-sqlite` mock (line 52) for the AsyncStorage `Map` mock; keep every test case |

## NOT Building
- **No version-align of `expo-sqlite`** (the rejected alternative — see ARCHITECT). Avoids a `prebuild` + full native recompile + device-build cycle and the broader SDK-54/55 skew.
- **No removal of `expo-sqlite` from `package.json` now** — leaving it installed-but-unused keeps this fix JS-only (no native rebuild). Removal is an optional follow-up (Task 7) that needs a prebuild + rebuild.
- **No data migration** — the SQLite DB never opened on-device, so there is **no persisted queue data to migrate**. Fresh AsyncStorage key starts empty.
- **No change to `enqueue`/`drainQueue`/`getQueueDepth`/`getAllQueueRows`/`clearFailedRows` signatures** — drop-in; `CaptureScreen` consumers untouched.
- No fix for the other version skews (`react-native-worklets`, `babel-preset-expo`, `typescript`) — separate concern.

---

## Step-by-Step Tasks

### Task 1: Swap imports + add storage helpers in `queue.ts`
- **ACTION**: Replace the `expo-sqlite` import and the `_db`/`getDb()` machinery with AsyncStorage helpers.
- **IMPLEMENT**:
  - Remove `import * as SQLite from "expo-sqlite";` → add `import AsyncStorage from "@react-native-async-storage/async-storage";`
  - Remove `let _db`, `getDb()`, `DB_NAME`. Add `const QUEUE_KEY = "carnet:queue:v1";`
  - Add:
    ```ts
    async function loadRows(): Promise<QueueRow[]> {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      if (!raw) return [];
      try { const p = JSON.parse(raw) as QueueRow[]; return Array.isArray(p) ? p : []; }
      catch { return []; }
    }
    async function saveRows(rows: QueueRow[]): Promise<void> {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(rows));
    }
    // Serialize read-modify-write so a concurrent enqueue during a drain pass
    // (CaptureScreen mount drains while a new failed capture enqueues) can't
    // lose a row. SQLite gave per-statement atomicity for free; AsyncStorage
    // RMW does not.
    let _lock: Promise<unknown> = Promise.resolve();
    function withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = _lock.then(fn, fn);
      _lock = run.then(() => {}, () => {});
      return run;
    }
    ```
- **MIRROR**: `LIST_PERSISTENCE` (storage.ts).
- **GOTCHA**: AsyncStorage RMW is not atomic — every mutation MUST go through `withLock`. Read-only reads (`getQueueDepth`, `getAllQueueRows`) may read unlocked (a slightly-stale depth is harmless).
- **VALIDATE**: `tsc --noEmit` — no unresolved `SQLite` references remain (`git grep -n SQLite apps/mobile/src/lib/queue.ts` empty).

### Task 2: Rewrite the mutators/readers to use the helpers (keep logic)
- **ACTION**: Re-point each exported function at `loadRows`/`saveRows`/`withLock`; preserve behavior exactly.
- **IMPLEMENT**:
  - `getQueueDepth`: `const rows = await loadRows(); return rows.filter(r => r.attempts < MAX_AUTO_RETRY_ATTEMPTS).length;`
  - `enqueue`: wrap in `withLock`: load → `rows.push({ id: localId(), mode: payload.mode, payload_json: JSON.stringify(payload), created_at: Date.now(), attempts: 0, last_error: null })` → save. Keep the `Haptics.impactAsync(...Light)` after.
  - `drainQueue`: keep `_draining` single-flight + `try/finally`. Replace `db.getAllAsync(... ORDER BY created_at ASC)` with `(await loadRows()).filter(r => r.attempts < MAX).sort((a,b) => a.created_at - b.created_at)`. Replace the per-row SQL:
    - corrupt/`DELETE` and success `DELETE` → `await removeRow(row.id)`
    - failure `UPDATE` → `await updateRow(row.id, newAttempts, msg)`
    where:
    ```ts
    function removeRow(id: string) {
      return withLock(async () => { const r = await loadRows(); await saveRows(r.filter(x => x.id !== id)); });
    }
    function updateRow(id: string, attempts: number, last_error: string) {
      return withLock(async () => {
        const r = await loadRows();
        const i = r.findIndex(x => x.id === id);
        if (i !== -1) { r[i] = { ...r[i], attempts, last_error }; await saveRows(r); }
      });
    }
    ```
  - `getAllQueueRows`: `const r = await loadRows(); return r.sort((a,b) => a.created_at - b.created_at);`
  - `clearFailedRows`: `withLock` → load → `saveRows(rows.filter(r => r.attempts < MAX_AUTO_RETRY_ATTEMPTS))`.
- **MIRROR**: `KEEP_THESE` (unchanged drain/classify/redact/single-flight), `LIST_PERSISTENCE`.
- **GOTCHA**: `drainQueue` reads a snapshot once, then mutates per-row under the lock — that's correct (new enqueues land next pass). Don't re-`loadRows` the whole loop list mid-drain. Keep `processRow` and `sanitizeError` calls exactly as-is.
- **VALIDATE**: behavior parity verified by the (rewritten) unit tests in Task 3.

### Task 3: Re-mock the test from `expo-sqlite` to AsyncStorage
- **ACTION**: In `queue.test.ts`, replace the `expo-sqlite` mock block with the AsyncStorage `Map` mock; keep every `describe`/`it`.
- **IMPLEMENT**:
  - Delete the `mockDb` object + `vi.mock("expo-sqlite", …)` (lines ~17-54) and the in-`beforeEach` `mockDb.*` re-implementations (~119-145).
  - Add the `IN_MEMORY_ASYNCSTORAGE_MOCK` (a `const _store = new Map<string,string>()` + `vi.mock("@react-native-async-storage/async-storage", …)` with `default: { getItem, setItem, removeItem }`).
  - Keep `vi.mock("expo-haptics", …)`, `./omniroute`, `./writer`, `@carnet/shared` mocks.
  - `beforeEach`: `_store.clear(); vi.clearAllMocks();`
  - The tests that pre-seed rows by writing to the SQLite `_rows` map (e.g. "oldest-first" at lines 203-204) must instead seed via `_store.set("carnet:queue:v1", JSON.stringify([...QueueRow]))` — note the `payload_json` field is a JSON **string** inside each row.
  - Assertions that read `_rows`/`_rows.size` become reads of the parsed `carnet:queue:v1` value (e.g. a helper `const rows = () => JSON.parse(_store.get("carnet:queue:v1") ?? "[]")`).
- **MIRROR**: `IN_MEMORY_ASYNCSTORAGE_MOCK` (storage.test.ts).
- **GOTCHA**: Keep the **single-flight** test (`drainQueue` ×2 in parallel) — with `withLock` serialization + `_draining`, the row still processes exactly once. The mock's `getItem`/`setItem` are async, matching production.
- **VALIDATE**: `npm -w @carnet/mobile test` — all queue tests pass; total suite stays green.

### Task 4: Static + unit validation
- **ACTION**: Run typecheck + tests.
- **VALIDATE**: `npm -w @carnet/mobile run typecheck` (0 errors) and `npm -w @carnet/mobile test` (was 220/220; queue count unchanged).

### Task 5: On-device verification (JS-only re-bundle build)
- **ACTION**: Rebuild the release APK (re-bundles JS into the existing `com.ventoux.carnet` native project — no `prebuild`, no native recompile, ~1-2 min) and test the offline path.
- **IMPLEMENT**: `cd apps/mobile && ANDROID_HOME=/home/user/Android/Sdk npm run android:release` → installs in place.
- **GOTCHA**: This is JS-only, but the installed app is a *release* build with JS bundled in, so the new queue code only reaches the device via a re-bundle build (or a dev-client + Metro session). No native change → fast build, no compile risk. Grant/keep RECORD_AUDIO etc. (new package already granted).
- **VALIDATE** (device): put the phone offline (airplane mode) or point OmniRoute at an unreachable host → capture an Idea → expect **"Offline — capture queued."** (NOT the red `NativeDatabase.constructor` error) and `getQueueDepth` badge ≥ 1. Restore connectivity, reopen Capture → the queued item enriches + writes (row drains to 0). Logcat shows **no** `SharedRef NoSuchMethodError`.

### Task 6 (optional follow-up — NOT this PR): drop the dead dependency
- **ACTION**: Once the AsyncStorage queue is confirmed, remove `expo-sqlite` entirely.
- **IMPLEMENT**: `npm -w @carnet/mobile uninstall expo-sqlite` → `npx expo prebuild --clean -p android` → release build → device retest. (Needs native rebuild because it removes a native module.)
- **GOTCHA**: This is the only step that touches native — keep it OUT of the JS-only fix so the fix ships fast and low-risk. Track separately.

---

## Testing Strategy

### Unit Tests (rewritten `queue.test.ts`, same cases)
| Test | Input | Expected | Edge? |
|---|---|---|---|
| enqueue adds a row | `{mode:"idea",text}` | `carnet:queue:v1` has 1 row, `payload_json` parses to payload | No |
| depth increments | 3 enqueues | `getQueueDepth() === 3` | No |
| drain removes on success | 1 row, enrich resolves | row gone | No |
| drain increments on failure | enrich rejects (transient) | `attempts===1`, `last_error` set, row stays | Yes |
| oldest-first | seed created_at 100/200 | processed "first" then "second" | Yes |
| journal/person payloads | enqueue each | correct enrich+write called, drained | No |
| permanent (4xx) | `isPermanentError → true` | `attempts===10` (won't retry) | Yes |
| Bearer redaction | error contains token | `last_error` has `Bearer [redacted]`, not the token | Yes (security) |
| single-flight | parallel `drainQueue()` ×2 | processed exactly once | Yes (concurrency) |

### Edge Cases Checklist
- [ ] Empty queue → `getQueueDepth()===0`, `drainQueue()` no-op
- [ ] Corrupt row (`payload_json` not JSON) → removed during drain (existing behavior)
- [ ] Corrupt `carnet:queue:v1` value (not an array) → `loadRows()` returns `[]` (guarded)
- [ ] Concurrent enqueue during drain → no lost row (lock)
- [ ] Permanent-failure rows excluded from depth + drain selection
- [ ] No `expo-sqlite` import remains

---

## Validation Commands

### Static Analysis
```bash
npm -w @carnet/mobile run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
npm -w @carnet/mobile test
```
EXPECT: All pass (queue suite green; total ≥ 220)

### No stale SQLite references
```bash
git grep -n "expo-sqlite\|SQLite\." -- apps/mobile/src
```
EXPECT: empty (only `package.json` still lists the dep until the optional Task 6)

### Device Validation (after JS re-bundle build)
- [ ] Offline capture → "Offline — capture queued." (no `NativeDatabase.constructor` red error)
- [ ] `adb logcat | grep -i SharedRef` → nothing during capture
- [ ] Reconnect + reopen Capture → queued item writes to disk; depth → 0

---

## Acceptance Criteria
- [ ] `queue.ts` uses AsyncStorage; no `expo-sqlite`/`SQLite.` references
- [ ] Public API (`enqueue`/`drainQueue`/`getQueueDepth`/`getAllQueueRows`/`clearFailedRows`) unchanged — `CaptureScreen` untouched
- [ ] All queue unit tests pass (re-mocked to AsyncStorage); total suite green
- [ ] typecheck clean
- [ ] On-device: offline capture queues + drains; no `SharedRef` error

## Completion Checklist
- [ ] Mirrors `storage.ts` RMW + `storage.test.ts` mock patterns
- [ ] Redaction (`sanitizeError`), single-flight, error-classify logic preserved verbatim
- [ ] Concurrency lock on every mutation
- [ ] `QueueRow` shape (incl. `payload_json`) unchanged
- [ ] No scope creep (version-align + dep-removal deferred)
- [ ] Self-contained — no codebase search needed to implement

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lost write under concurrent enqueue/drain | Medium without lock | Medium (dropped capture) | `withLock` serializes all RMW mutations |
| Test rewrite misses a seam (`_rows` → `_store`) | Medium | Low (caught by CI) | Mirror `storage.test.ts`; keep all cases; run suite |
| Installed release app still has old JS until rebuilt | Certain | Low | Task 5 re-bundle build (fast, JS-only) or dev-client/Metro |
| AsyncStorage value-size limits | Very low | Low | Queue holds small text only (no binaries); items drain quickly |
| Future dev reintroduces `expo-sqlite` | Low | Low | Optional Task 6 removes the dep; note in PR |

## Notes
- **Why not just `expo install expo-sqlite` (version-align to `~16.0.10`)?** It would fix the native module but requires a `prebuild --clean` + full native recompile + device-build loop, keeps a flaky native dependency the queue doesn't need, and lives amid other SDK-54/55 skews (`react-native-worklets@0.8.3` vs `0.5.1`, `babel-preset-expo@55` vs `54`). AsyncStorage is already-working, JS-only, JS-testable, and mirrors `storage.ts`. The queue stores a handful of small text rows — SQLite is overkill.
- Independent of the merged STT (#25) and rename (#26) work; do on its own branch off `main`.
- The `localId()` (non-crypto) + `react-native-get-random-values` gap was already handled in PR #24 — no `uuid` involvement here.
