# PR Review: #27 — fix: replace broken expo-sqlite offline queue with AsyncStorage

**Reviewed**: 2026-06-04
**Author**: bearyjd
**Branch**: fix/offline-queue-asyncstorage → main
**Decision**: APPROVE (independent review; author cannot self-approve on GitHub → posted as comment)

## Summary
Faithful storage-layer migration: the offline capture queue moves from the broken `expo-sqlite` native module (SharedRef ABI error, SDK 54 vs the `@55` package) to AsyncStorage, mirroring `storage.ts`. An independent code-reviewer pass (opus, separate lane) confirmed byte-for-byte behavior parity (oldest-first drain, 4xx→permanent classification, Bearer redaction, single-flight) and a correct, deadlock-free `withLock` serialization. No CRITICAL/HIGH issues. The two actionable MEDIUMs were addressed in this PR.

## Findings

### CRITICAL
None.

### HIGH
None. (One HIGH-severity item — `_draining` not under the lock — was raised at LOW confidence: it's safe under the current single, synchronously-guarded `drainQueue` caller; the synchronous `if (_draining) return` set-before-await invariant holds. No reachable double-process. Noted for future callers.)

### MEDIUM — both addressed in this PR
- **Stale-snapshot `attempts` write**: `drainQueue` computed `row.attempts + 1` from the unlocked snapshot and passed an absolute value to the locked write. **Fixed** — replaced `updateRow(id, attempts, …)` with `bumpAttempts(id, permanent, …)` which computes the increment from the freshly-loaded row inside `withLock`.
- **`getAllQueueRows` in-place `.sort()`** (violates the immutability rule). **Fixed** — `return [...rows].sort(...)`.

### LOW
- Unbounded growth: permanent-failure rows (`attempts >= MAX`) persist until `clearFailedRows`. Pre-existing (same as SQLite original); not a regression. Possible future TTL/cap.
- Test coverage: added the **corrupt-`payload_json` drain** test (the new risk surface). Not added (optional follow-up): a concurrent-enqueue-during-drain test and `clearFailedRows`/`getAllQueueRows` assertions.

## Validation Results
| Check | Result |
|---|---|
| Type check | Pass (`tsc --noEmit`) |
| Lint | N/A (no lint script; typecheck is the static gate) |
| Tests | Pass — 221/221 (queue suite 11/11) |
| Build | Pass — release APK `BUILD SUCCESSFUL` (JS re-bundle) |

## Files Reviewed
- `apps/mobile/src/lib/queue.ts` — Modified (storage layer SQLite → AsyncStorage; `bumpAttempts`; immutable sort)
- `apps/mobile/src/lib/queue.test.ts` — Modified (AsyncStorage mock; +corrupt-row test; 11 cases)
- `apps/mobile/src/lib/storage.ts` — parity reference (unchanged)
- `apps/mobile/src/screens/CaptureScreen.tsx` — sole consumer (unchanged; public API preserved)

## Remaining (non-blocking)
- On-device confirmation of the offline path (airplane mode → queued → reconnect drains) — APK built, install pending (test device dropped off adb).
