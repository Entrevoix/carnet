# Local Review: feat/photo-capture-mode

**Reviewed**: 2026-05-17
**Branch**: feat/photo-capture-mode (uncommitted)
**Decision**: APPROVE with comments

## Summary
The post-fix branch is in good shape. Two HIGH issues from the first review (size guard, duplicate-save on `recordCapture` failure) are resolved correctly in both PhotoCaptureScreen and ShareReceiveScreen. The new `injectImageEmbed` helper is well-tested. Two MEDIUM and three LOW findings remain — none blocking.

## Files Reviewed (9)
- **Added**: `apps/mobile/src/screens/PhotoCaptureScreen.tsx`
- **Modified**: `apps/mobile/App.tsx`, `apps/mobile/src/lib/omniroute.ts`, `apps/mobile/src/lib/storage.ts`, `apps/mobile/src/lib/writer.ts`, `apps/mobile/src/lib/writer.test.ts`, `apps/mobile/src/screens/HomeScreen.tsx`, `apps/mobile/src/screens/ShareReceiveScreen.tsx`, `README.md`

## Findings

### CRITICAL
None.

### HIGH
None. Both prior HIGH issues (missing size guard, duplicate-save on `recordCapture` failure) are now correctly handled in both screens.

### MEDIUM

**[M1] ShareReceiveScreen size guard only triggers when share-intent reports `size`**
File: `apps/mobile/src/screens/ShareReceiveScreen.tsx:108-114`
Some Android share providers (especially via FileProvider/content://) hand carnet an `imageFile` without `size`. The guard `if (imageFile.size && imageFile.size > MAX_SHARED_IMAGE_BYTES)` short-circuits → a 50 MP image proceeds to read-as-base64 → OOM risk before the vision call.
Fix: After the `base64 = await ...readAsStringAsync(...)` lines, also call `assertBase64UnderLimit(base64)`. Same belt-and-suspenders the PhotoCapture path uses. ~2 lines.

**[M2] Double-Save race in both screens — rapid tap before re-render can write twice**
File: `apps/mobile/src/screens/PhotoCaptureScreen.tsx:130-179`, `apps/mobile/src/screens/ShareReceiveScreen.tsx:93-218`
`save()` is async. `setPhase("submitting")` schedules a re-render but doesn't block the next press immediately. A fast double-tap on Save fires `save()` twice before React unmounts the preview button → two `writeBinary` + two `writeIdea` calls → two paired notes with collision-bumped names for one capture.
The `if (!base64 || !enrichedMd) return;` guard is insufficient because both remain truthy until after the first call's body executes.
Fix: Add a `useRef<boolean>(false)` flag (`savingRef`) set at the top of `save()` and cleared in the `catch`/`finally`, checked at entry. ShareReceiveScreen has the same latent issue (pre-existing).

### LOW

**[L1] README ASCII diagram still labels the mobile column "CaptureScreen.tsx"**
File: `README.md:10-14`
The diagram lists "Photo (camera→vision)" as a sub-bullet under "CaptureScreen.tsx", but Photo lives in `PhotoCaptureScreen.tsx`. Cosmetic — the diagram is illustrative, not architectural.
Fix (optional): Change the box header to "CaptureScreen + PhotoCaptureScreen" or drop the filename.

**[L2] `assertBase64UnderLimit` throws with status 0 (network-level)**
File: `apps/mobile/src/lib/omniroute.ts:99-108`
`isPermanentError(err)` checks `status >= 400 && status < 500`, so status 0 returns `false`. A capture-screen error path that retries on transient failures would loop on an oversized image forever. The current callers do not retry, but a future caller using OmniRoute's classifier would mishandle this.
Fix (optional): Either pick a 4xx status (e.g., 413 Payload Too Large) so `isPermanentError` correctly classifies it, or document that status 0 is overloaded for client-side caps.

**[L3] CRLF test in `injectImageEmbed` uses weak assertions**
File: `apps/mobile/src/lib/writer.test.ts:189-195`
The CRLF test only asserts `toContain` for three substrings. It does not pin the exact output, so a regression that mishandles `\r\n` placement (e.g., swallowing the `\r`) would silently pass.
Fix (optional): Replace with a `toBe` against the exact expected output.

## Category Coverage

| Category | Verdict |
|---|---|
| Correctness | One race condition (M2), otherwise sound |
| Type Safety | All explicit, no `any`, narrowed `unknown` errors |
| Pattern Compliance | Mirrors ShareReceiveScreen + CardScannerModal patterns correctly |
| Security | No injection / traversal / secret exposure. `slugify` strips path separators; `enrichSharedImage` re-validates mime |
| Performance | base64 bounded by new 8 MB cap; no N+1 or unbounded loops |
| Completeness | Acceptance criteria met; screen-level RN testing deferred per plan; unit tests added for the extracted helper |
| Maintainability | Helpers extracted to `lib/`; magic numbers documented; comments explain WHY (e.g., `assertBase64UnderLimit` JSDoc on quality vs resolution) |

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass — zero errors |
| Lint | Skipped — no lint script defined in `apps/mobile/package.json` |
| Tests (`vitest run`) | Pass — 69/69 (46 writer incl. 6 new for `injectImageEmbed`, 10 queue, 13 omniroute) |
| Build | Skipped — no native rebuild needed (`expo-camera` already linked) |

## Decision: APPROVE with comments
No CRITICAL or HIGH findings remaining. The two MEDIUM issues are real but not blocking — M1 has a workable workaround (the existing `size` check catches most cases) and M2 is a latent race condition pre-existing in ShareReceiveScreen that this PR does not make worse. Recommend addressing M1 and M2 in this PR if scope allows (each is ~5 lines), otherwise file as follow-ups.

## Recommended next steps
- **In-scope quick wins**: M1 (add `assertBase64UnderLimit` call to ShareReceiveScreen after base64 read) and M2 (add `savingRef` to both screens).
- **Out-of-scope follow-ups**: L1, L2, L3.
- **Required before ship**: On-device validation (Task 7 from the plan) — agent cannot exercise the camera or vault writes.
