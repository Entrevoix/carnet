# Implementation Report: Up-front provider-readiness hint in the card scanner

## Summary

The card scanner now warns, the moment it opens, that the vision provider is
unconfigured — instead of only after the user has framed and taken a photo. The
warning is non-blocking: the camera opens immediately and Capture stays enabled,
because the save-first flow writes the original image before OCR is attempted.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small | Small — accurate |
| Confidence | 9/10 | Single pass, no rework |
| Files Changed | 6 | 6 |
| Tests added | ~6 | 10 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extract the vision pre-flight asserts | Complete | `assertVisionReady()` exported from `llmClient.ts`; `ocrCardViaVision` now calls it, so one implementation serves both paths |
| 2 | Add the dispatcher probe | Complete | `probeVisionReadiness()` — same provider resolution, no network call |
| 3 | Classify the probe + pre-flight copy | Complete | `probeCardScanReadiness()`, `cardScanPreflightHint()` |
| 4 | Render the banner in the scanner | Complete | `useEffect` on `visible`, fire-and-forget, cancelled-flag cleanup |
| 5 | Tests | Complete | 10 tests across two files |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| L1 Static — typecheck | Pass | zero errors |
| L1 Static — lint | Pass | `void` satisfies the typed `no-floating-promises` rule |
| L2 Unit — targeted | Pass | 95 across `cardScanOutcome` + `llmClient` |
| L2 Unit — full mobile | Pass | 97 files / **1573 tests** (was 1563) |
| L3 Build | Pass | `build:shared` clean |
| L4 Integration | N/A | no server in this project |
| L5 Edge cases | Pass | `verify:capture-flow` 272 |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/llmClient.ts` | UPDATED | +25 / −4 |
| `apps/mobile/src/lib/dispatcher.ts` | UPDATED | +20 |
| `apps/mobile/src/lib/cardScanOutcome.ts` | UPDATED | +29 / −1 |
| `apps/mobile/src/components/CardScannerModal.tsx` | UPDATED | +30 / −1 |
| `apps/mobile/src/lib/cardScanOutcome.test.ts` | UPDATED | +57 |
| `apps/mobile/src/lib/llmClient.test.ts` | UPDATED | +42 |

## Deviations from Plan

**Implementation: none.** Every task landed as written, including the three
design decisions the plan's exploration phase forced (probe the vision provider
not the active one; ignore the fallback chain; render the banner inside the
modal). Those were the parts most likely to need rework, and pre-capturing them
is why this was a single pass.

**Process: the plan was NOT archived to `plans/completed/`.** The skill's Phase 5
says to archive on implementation. This repo's `CLAUDE.md` ties `Status: shipped`
+ `completed/` to work that has actually landed, and prematurely marking a plan
shipped is a documented failure mode here (it has cost a human audit cycle
before). The plan is `Status: in-progress` in `plans/` and moves to `completed/`
when the PR merges — matching how the other three plans were handled today.
`check-stale-plans.sh` passes in this state.

## Issues Encountered

None during implementation. The three traps that would normally cause rework
were found during planning, not coding:

1. Checking `resolveActiveProvider(...).baseUrl` — the shape of the deleted PR
   #29 guard — warns on correctly-configured setups, because OCR resolves via
   `resolveVisionProviderId(settings)`.
2. A hint set in `CaptureModeInput` renders *behind* the modal and is invisible
   until the scanner closes.
3. Probing the fallback provider would under-warn, since
   `shouldRetryWithFallback` returns `false` for not-configured errors.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/cardScanOutcome.test.ts` | +6 | probe ok / notConfigured / never-rejects; pre-flight copy asserts "still capture", never "was saved", and stays silent for ok/permanent/transient |
| `apps/mobile/src/lib/llmClient.test.ts` | +4 | `assertVisionReady` return shape, blank vision model, blank URL, and assert ORDER (vision model reported first) |

## Not Verified

The banner has **not** been seen on a device. It is unit-tested only. The device
check is in `docs/smoke-test.md` under "Capture — Person (without the gateway)":
clear the vision model, open the scanner, confirm the banner appears before
framing and that Capture still lands the image.

## Next Steps
- [ ] `/code-review` or `/codex review`
- [ ] `/prp-pr`
- [ ] Device smoke: banner on open, capture still works, no banner when configured
- [ ] On merge: `Status: shipped` + move to `plans/completed/`
