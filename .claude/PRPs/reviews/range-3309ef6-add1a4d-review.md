# Range Review: 3309ef6..add1a4d — voice error-policy work + B2 OCR fold

**Reviewed**: 2026-07-12
**Author**: bearyjd (direct commits to main; each large diff also agent-reviewed pre-commit)
**Range**: 3309ef6 (double-restart race fix) → add1a4d (session handoff)
**Decision**: APPROVE

## Summary

Consolidated post-push review deliberately scoped to what the per-commit reviews could not
see: the orchestrator's hand-written post-review edits (`openAppDetails` rewrite to
`requireOptionalNativeModule`, the code-7 silence-counter gate, the two ported omniroute
parity tests) and the never-agent-reviewed commit `063ae09` (`reviveUserRecoverablePkgs`),
plus cross-commit interactions (silence auto-stop × code-9 revival × mic-revoked sheet).
All verifications passed, including the native-module contract checked byte-for-byte against
`expo-intent-launcher`'s Kotlin source and an ordering trace of the revival → re-fail →
re-classification path. No blocking findings.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM
None

### LOW
1. `VoiceButton.tsx:446-455` — `openAppDetails` guards module presence but not method
   presence; a present-but-incompatible native module lacking `startActivity` would throw a
   synchronous TypeError that escapes the promise `.catch`. Practically unreachable (method
   exists since module inception, version pinned ~13.0.8). Optional fix:
   `launcher.startActivity?.(…)?.catch(…)` or try/catch.
2. `VoiceButton.tsx:1283` — fresh-tap clears `errMsg` but leaves `errAction`/
   `micRevokedTarget` stale; correctness relies on the modal's `errMsg.length > 0` gate.
   Harmless today; optional defensive `dismissErr()` on session start.
3. `VoiceButton.tsx:1141/1272` vs `:461-462` — mixed set-reset idioms (reassignment vs
   in-place `.clear()`) for the same refs; pick one for readability.

## Verifications (traced in committed code)

- Native contract: `startActivity(action, {data})` matches IntentLauncherModule.kt;
  `requireOptionalNativeModule` returns null, never throws; fallback cannot double-fire.
- code-7 gate matches sttErrorPolicy's `!pressActive` swallow semantics; error-path and
  end-path counter increments are mutually exclusive via the errorHandlingRef latch.
- Revival wiring identical at both session-start sites; code-9 recurrence re-populates
  `code9PkgsRef` before terminal-sheet classification; set immutability holds throughout.
- Auto-stop leaves no residual state a fresh tap mishandles; `micRevokedTarget` cannot
  render stale (always paired with `errAction`, modal gated on `errMsg`).
- Hand-added parity tests are real assertions with correct mock hygiene; 113/113 in the
  two affected files.

## Validation Results

| Check | Result |
|---|---|
| build:shared | Pass |
| tsc --noEmit (mobile) | Pass |
| tsc --noEmit (shared) | Pass |
| vitest (mobile) | Pass — 917/917 (59 files) |
| vitest (shared) | Pass — no test files by design |
| Lint | Skipped — repo has no lint step (deliberate, per CLAUDE.md) |
| CI (GitHub) | Green through 063ae09; run for add1a4d in flight (first mobile-android build with expo-intent-launcher) |

## Files Reviewed

- apps/mobile/src/voice/VoiceButton.tsx (M)
- apps/mobile/src/voice/sttErrorPolicy.ts / .test.ts (A)
- apps/mobile/src/voice/sttErrorMessage.ts (M)
- apps/mobile/src/lib/omniroute.ts / .test.ts (M)
- apps/mobile/src/components/CardScannerModal.tsx (M)
- apps/mobile/src/lib/ocr.ts / .test.ts (D)
- apps/mobile/package.json, package-lock.json (M — expo-intent-launcher ~13.0.8)
- TODO.md, docs/CODEMAPS/backend.md, docs/CODEMAPS/dependencies.md (M)
- docs/session-handoffs/2026-07-12-voice-policy-b2-fold-and-device-incidents.md (A)
