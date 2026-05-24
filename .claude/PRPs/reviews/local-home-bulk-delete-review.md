# Local Code Review: Home bulk delete (multi-select)

**Reviewed**: 2026-05-21
**Reviewer**: self (Claude Code)
**Branch**: `feat/home-bulk-delete` (vs `main`)
**Decision**: APPROVE with comments (M1 + M2 applied in-review; L1–L3 noted as follow-ups)

## Summary
Small focused diff (3 files, +214/-21, 5 new tests). Two MEDIUM findings caught and fixed in-review: silent archive failures now log per item, and the Checkbox is decorative-only so a checkbox tap can't double-fire with the row's onPress. No CRITICAL/HIGH.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M1. `moveToArchive` failures inside `Promise.allSettled` were silently swallowed — APPLIED**

`apps/mobile/src/screens/HomeScreen.tsx` `handleBulkDelete`. Plan intentionally chose `allSettled` so one SAF revocation doesn't abort the bulk operation. But zero per-failure logging meant the user had no signal when N of M archives quietly didn't happen — files stay in original dir, recents row gone, mystery.

Fix:
```ts
const results = await Promise.allSettled(
  entries.map((e) => moveToArchive(e.filepath)),
);
results.forEach((r, i) => {
  if (r.status === "rejected") {
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.warn(`[Home] archive failed for ${entries[i].filepath}: ${reason}`);
  }
});
```
Logs per-file path + reason. Matches the existing `console.warn` pattern from RecentDetail / ShareReceive / PhotoCapture.

**M2. Checkbox `onPress` + row `onPress` could double-toggle on a checkbox tap — APPLIED**

`apps/mobile/src/screens/HomeScreen.tsx`. Per the plan's risks table — RN gesture responders usually pick one onPress, but layering a Checkbox inside a TouchableRipple was ambiguous enough to be worth eliminating. Made the `Checkbox.Android` decorative-only (no `onPress`). The row's `onPress` owns the toggle in selection mode, and a tap on the checkbox area bubbles to the row's TouchableRipple.

```diff
  <Checkbox.Android
    status={selected ? "checked" : "unchecked"}
-   onPress={() => toggleSelection(item.id)}
  />
```

### LOW

- **L1.** `setSelectionMode(false)` called inside the `setSelectedIds` updater is a side effect inside a state setter — slight React anti-pattern. React 18+ StrictMode invokes updaters twice for debugging; the duplicate `setSelectionMode(false)` is idempotent so no visible bug, but a `useEffect` keyed on `selectedIds.size === 0` would be more idiomatic. Deferred.
- **L2.** `await refresh()` in the `finally` block could propagate an AsyncStorage rejection upward to the unawaited Button.onPress. Unlikely; AsyncStorage rarely throws on read. Deferred.
- **L3.** `console.warn` for non-fatal errors — matches the existing project pattern; project-wide structured-logger upgrade is its own concern.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `tsc --noEmit` clean (post-M1/M2 fixes) |
| Lint | N/A | No `lint` script |
| Tests | ✅ Pass | 150/150 across 6 files |
| Build | N/A | Pure JS diff |

## Files Reviewed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | Modified | +18 (`removeManyFromHistory`) |
| `apps/mobile/src/lib/storage.test.ts` | Modified | +48 (5 new tests + import) |
| `apps/mobile/src/screens/HomeScreen.tsx` | Modified | +172/-21 (post-M1/M2 — added 3 lines for the per-failure log, removed 1 line for the checkbox onPress) |

## Decision Rationale
Zero CRITICAL/HIGH. M1 was a real "you'll wonder why files disappeared" debuggability gap — fixed. M2 eliminated a theoretical responder-system ambiguity with a cleaner UX intent. L1–L3 are documented but non-blocking.

## Manual validation still pending
The screen-level interaction (long-press → mode entry, tap toggle, deselect-to-zero auto-exit, blur clears, Promise.allSettled actually surviving partial failures on device) requires on-device verification per the plan's 11-item checklist.
