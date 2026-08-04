# Plan: Up-front provider-readiness hint in the card scanner

Status: in-progress

## Summary

Warn the user that the vision provider is unconfigured **when the card scanner
opens**, instead of only after they have taken a photo. The warning is
non-blocking: the camera still opens and Capture still works, because the
save-first flow writes the original image before OCR is attempted and that image
is worth keeping regardless.

## User Story

As someone scanning a business card, I want to be told my provider is not set up
*before* I frame the shot, so that I either fix Settings first or knowingly
capture the image for later instead of discovering the problem afterwards.

## Problem → Solution

Today the user taps **Scan card**, frames, taps **Capture**, waits, and only then
sees "… not configured — set it in Settings." The image is saved (good), but the
round trip is wasted. → Show the same, already-classified message as a banner
inside the scanner the moment it opens.

## Metadata

- **Complexity**: Small
- **Source PRD**: N/A (follow-up from the PR #126 Codex review)
- **PRD Phase**: N/A
- **Estimated Files**: 4 changed (2 source, 2 test)

---

## UX Design

### Before

```
┌───────────────────────────────┐
│ Scan card                  ✕  │
│ ┌───────────────────────────┐ │
│ │                           │ │
│ │      live camera          │ │   user frames and shoots…
│ │                           │ │
│ └───────────────────────────┘ │
│ [        Capture           ]  │
└───────────────────────────────┘
        ↓ tap Capture, wait for OCR to fail
┌───────────────────────────────┐
│ … not configured — set it in  │
│ Settings. Your card image was │
│ saved — scanning again won't  │
│ help until this is set.       │
└───────────────────────────────┘
```

### After

```
┌───────────────────────────────┐
│ Scan card                  ✕  │
│ ⚠ OmniRoute URL not configured│  ← visible immediately on open
│   — set it in Settings. You   │
│   can still capture; the card │
│   image is saved for later.   │
│ ┌───────────────────────────┐ │
│ │      live camera          │ │
│ └───────────────────────────┘ │
│ [        Capture           ]  │   ← still enabled, still works
└───────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Open scanner | No signal | Banner if unconfigured; nothing if ready | Non-blocking |
| Capture button | Enabled | Enabled (unchanged) | Deliberately NOT disabled — image still worth saving |
| Post-capture message | Only signal | Unchanged | Still classified three ways |
| Configured provider | No banner | No banner | Zero change on the happy path |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/cardScanOutcome.ts` | all (49) | The classifier and hint copy to extend — do not add a second classification |
| P0 | `apps/mobile/src/lib/dispatcher.ts` | 94-130, 199-217, 242-249, 318-332 | `buildConfig`, `withFallbackChain`, `resolveVisionProviderId`, `ocrCardViaVision` |
| P0 | `apps/mobile/src/lib/llmClient.ts` | 237-245, 271-281, 610-625 | The three pre-flight asserts to extract |
| P0 | `apps/mobile/src/components/CardScannerModal.tsx` | all | Where the banner renders |
| P1 | `apps/mobile/src/lib/dispatcher.ts` | 150-160 | `shouldRetryWithFallback` — why probing the primary alone is correct |
| P2 | `apps/mobile/src/lib/cardScanOutcome.test.ts` | all | Test shape to mirror |

## External Documentation

No external research needed — feature uses established internal patterns.

---

## Critical Gotchas (read before designing anything)

1. **The vision provider is NOT `activeProviderId`.** `ocrCardViaVision` resolves
   through `resolveVisionProviderId(settings)` (`dispatcher.ts:242`), which
   consults `settings.visionProviderId` first. Checking
   `resolveActiveProvider(...).baseUrl` in the component — the shape of the
   deleted PR #29 guard — is **wrong** and will warn on correctly-configured
   setups.

2. **Do not consider the fallback chain.** `shouldRetryWithFallback`
   (`dispatcher.ts:156-159`) returns `false` for `isNotConfiguredError`, so an
   unconfigured primary never falls back — the chain throws immediately.
   Probing the primary alone therefore matches runtime behavior exactly. Probing
   the fallback too would under-warn.

3. **A hint set in `CaptureModeInput` is invisible.** Its `hint` HelperText
   (`CaptureModeInput.tsx:156-160`) renders *behind* `CardScannerModal`. The
   user would not see it until they closed the scanner, which is precisely when
   it no longer matters. The banner MUST render inside the modal.

4. **The existing hint copy is post-capture.** `cardScanHint` says "Your card
   image was saved" — untrue before a capture. Pre-flight needs its own copy;
   reuse the *classification*, not the sentence.

5. **Never disable Capture.** The save-first design exists so a failed OCR does
   not lose the card. Blocking capture would reintroduce exactly the data loss
   the save-first flow removed.

---

## Patterns to Mirror

### PREFLIGHT_ASSERTS (the three calls to extract)
```ts
// SOURCE: apps/mobile/src/lib/llmClient.ts:610-614 (inside ocrCardViaVision)
const model = assertVisionModelConfigured(config.visionModel, config.label);
const trimmed = assertUrlConfigured(config.baseUrl, config.label);
const trimmedUrl = trimmed.replace(/\/+$/, "");
assertHttpsOrLocal(trimmedUrl, config.label);
```

### NOT_CONFIGURED_ERROR
```ts
// SOURCE: apps/mobile/src/lib/llmClient.ts:237-245
function assertUrlConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LlmClientError(`${label} URL not configured — set it in Settings`, 0, {
      notConfigured: true,
    });
  }
  return trimmed;
}
```

### CLASSIFICATION (reuse, do not duplicate)
```ts
// SOURCE: apps/mobile/src/lib/cardScanOutcome.ts:26-33
export function classifyCardScanOcrError(error: unknown): CardScanOcrFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (isNotConfiguredError(error)) return { kind: "notConfigured", message };
  if (isPermanentError(error)) return { kind: "permanent", message };
  return { kind: "transient", message };
}
```

### DISPATCHER_ENTRY_POINT
```ts
// SOURCE: apps/mobile/src/lib/dispatcher.ts:318-326
export async function ocrCardViaVision(input: {
  base64: string; mimeType: string;
}): Promise<{ text: string }> {
  const settings = await getSettings();
  const primaryId = resolveVisionProviderId(settings);
  const { result } = await withFallbackChain(settings, primaryId, (config) =>
    llmClient.ocrCardViaVision(input, config),
  );
  return result;
}
```

### TEST_STRUCTURE (dispatcher seam is mocked)
```ts
// SOURCE: apps/mobile/src/lib/cardScanOutcome.test.ts:7-13
const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);
vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
}));
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/llmClient.ts` | UPDATE | Extract the three pre-flight asserts into an exported `assertVisionReady(config)`; `ocrCardViaVision` calls it so there is exactly one implementation |
| `apps/mobile/src/lib/dispatcher.ts` | UPDATE | Add `probeVisionReadiness()` reusing `getSettings` + `resolveVisionProviderId` + `buildConfig` |
| `apps/mobile/src/lib/cardScanOutcome.ts` | UPDATE | Add `probeCardScanReadiness()` and `cardScanPreflightHint()` |
| `apps/mobile/src/components/CardScannerModal.tsx` | UPDATE | Probe on open; render the banner above Capture |
| `apps/mobile/src/lib/cardScanOutcome.test.ts` | UPDATE | Cover the probe + pre-flight copy |
| `apps/mobile/src/lib/llmClient.test.ts` | UPDATE | Cover `assertVisionReady` directly |

## NOT Building

- Disabling or gating the Capture button.
- Any pre-flight **network** call. This is a config check only — no reachability
  probe, no token spend, no latency before the camera appears.
- Restoring PR #29's early-return that prevented the scanner from opening.
- A hint in `CaptureModeInput.open()` (invisible behind the modal — gotcha #3).
- Probing the fallback provider (gotcha #2).
- Any change to post-capture behavior or copy.

---

## Step-by-Step Tasks

### Task 1: Extract the vision pre-flight asserts
- **ACTION**: In `llmClient.ts`, add an exported `assertVisionReady(config: ProviderConfig): { model: string; url: string }`.
- **IMPLEMENT**: Move the three calls from `ocrCardViaVision` (see PREFLIGHT_ASSERTS) into it, returning `{ model, url: trimmedUrl }`; have `ocrCardViaVision` call it and use the returned values.
- **MIRROR**: PREFLIGHT_ASSERTS, NOT_CONFIGURED_ERROR.
- **IMPORTS**: none new.
- **GOTCHA**: Preserve assert ORDER (vision model, then URL, then https/local). The existing tests pin which message a blank-everything config produces; reordering changes it.
- **VALIDATE**: `npx vitest run src/lib/llmClient.test.ts --root apps/mobile` — existing not-configured tests still pass unchanged.

### Task 2: Add the dispatcher probe
- **ACTION**: In `dispatcher.ts`, add `export async function probeVisionReadiness(): Promise<void>`.
- **IMPLEMENT**: `const settings = await getSettings(); const id = resolveVisionProviderId(settings); const config = await buildConfig(settings, id); llmClient.assertVisionReady(config);` — throws exactly what the real call throws.
- **MIRROR**: DISPATCHER_ENTRY_POINT (same resolution order, minus the network call).
- **IMPORTS**: already in scope in `dispatcher.ts`.
- **GOTCHA**: Do NOT wrap in `withFallbackChain` — gotcha #2.
- **VALIDATE**: typecheck; assert it throws for a blank-URL settings fixture.

### Task 3: Classify the probe and write pre-flight copy
- **ACTION**: In `cardScanOutcome.ts`, add `probeCardScanReadiness()` and `cardScanPreflightHint()`.
- **IMPLEMENT**:
  ```ts
  export async function probeCardScanReadiness(): Promise<CardScanOcrOutcome> {
    try { await probeVisionReadiness(); return { kind: "ok" }; }
    catch (error) { return classifyCardScanOcrError(error); }
  }

  export function cardScanPreflightHint(outcome: CardScanOcrOutcome): string | null {
    if (outcome.kind !== "notConfigured") return null;
    return `${outcome.message}. You can still capture — the card image is saved for later.`;
  }
  ```
- **MIRROR**: CLASSIFICATION.
- **IMPORTS**: add `probeVisionReadiness` to the existing `./dispatcher` import.
- **GOTCHA**: Return `null` for `permanent`/`transient`. Those describe a *call* that failed; before any call they are meaningless, and a transient banner on open would be noise. Only `notConfigured` is knowable up front.
- **VALIDATE**: `npx vitest run src/lib/cardScanOutcome.test.ts --root apps/mobile`.

### Task 4: Render the banner in the scanner
- **ACTION**: In `CardScannerModal.tsx`, probe when `visible` flips true and render the banner above Capture.
- **IMPLEMENT**: `useEffect` on `visible`; `void probeCardScanReadiness().then((o) => setPreflight(cardScanPreflightHint(o)))`; guard with a cancelled flag in cleanup; render `<HelperText type="error" visible>{preflight}</HelperText>` when non-null. Clear on close.
- **MIRROR**: existing `error` state/render in the same component.
- **IMPORTS**: `useEffect` from react; `cardScanPreflightHint`, `probeCardScanReadiness` from `../lib/cardScanOutcome`.
- **GOTCHA**: Fire-and-forget, never `await` before showing the camera — the probe reads SecureStore and must not delay the preview. Also set the cancelled flag in cleanup so a fast open/close does not `setState` after unmount.
- **VALIDATE**: `npm -w @carnet/mobile run lint` (the typed `no-floating-promises` rule is one of the three enabled — the `void` is required).

### Task 5: Tests
- **ACTION**: Extend `cardScanOutcome.test.ts` and `llmClient.test.ts`.
- **IMPLEMENT**: probe returns `ok` when ready / `notConfigured` when the vision model is blank; `cardScanPreflightHint` returns null for ok/permanent/transient and never claims the image "was saved"; `assertVisionReady` throws `notConfigured` for blank URL and blank vision model.
- **MIRROR**: TEST_STRUCTURE.
- **GOTCHA**: `./dispatcher` pulls the React Native module graph and dies on `__DEV__`; keep mocking that seam as the existing suite does.
- **VALIDATE**: full mobile suite.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| probe ok | fully configured | `{kind:"ok"}` | |
| probe blank URL | `baseUrl:""` | `{kind:"notConfigured"}` | |
| probe blank vision model | `visionModel:""` | `{kind:"notConfigured"}` | ✓ |
| preflight hint copy | notConfigured | contains "still capture", NOT "was saved" | ✓ |
| preflight hint suppressed | ok/permanent/transient | `null` | ✓ |
| assertVisionReady order | all blank | vision-model message wins | ✓ |

### Edge Cases Checklist
- [ ] Blank vision model but valid URL (the case a `baseUrl`-only check misses)
- [ ] `visionProviderId` differs from `activeProviderId`
- [ ] Modal opened and closed before the probe resolves (no setState-after-unmount)
- [ ] Provider configured → no banner at all
- [ ] Capture still succeeds while the banner is showing

---

## Validation Commands

```bash
npm run build:shared
npm -w @carnet/mobile run typecheck     # EXPECT: zero errors
npm -w @carnet/mobile run lint          # EXPECT: clean (no-floating-promises)
npm -w @carnet/mobile test              # EXPECT: no regressions vs 1563
npm -w @carnet/mobile run verify:capture-flow   # EXPECT: 272 pass
```

### Manual Validation (device — `docs/smoke-test.md`)
- [ ] Clear the vision model → open scanner → banner appears immediately
- [ ] Capture anyway → image + capture package still land in the vault
- [ ] Restore the vision model → open scanner → no banner
- [ ] Point at an unreachable host → **no** banner on open (transient is not knowable up front), failure still classified after capture

---

## Acceptance Criteria
- [ ] Banner appears on open only when the vision provider is unconfigured
- [ ] Camera preview is not delayed by the probe
- [ ] Capture remains enabled and functional in every state
- [ ] Exactly one implementation of the pre-flight asserts, shared with `ocrCardViaVision`
- [ ] No network call added to the open path
- [ ] All validation commands pass

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Probe duplicates assert logic and drifts | Medium | High — the bug this replaces | `ocrCardViaVision` calls the same `assertVisionReady`; drift is impossible by construction |
| Banner shown for a configured provider | Low | Medium — trains users to ignore it | Resolve via `resolveVisionProviderId`, never `activeProviderId` (gotcha #1) |
| SecureStore read delays the camera | Low | Medium | Fire-and-forget, never awaited before render |
| setState after unmount on fast close | Medium | Low | Cancelled flag in the effect cleanup |

## Notes

Origin: Codex review of PR #126 flagged that deleting PR #29's guard lost the
specific "not configured" diagnostic. The post-capture half was fixed in
`89e4b97` (three-way classification off the typed `notConfigured` flag). This
plan is the remaining, optional up-front half.

The deleted PR #29 guard read `resolveActiveProvider(...).baseUrl` directly in
the component. That shape is now doubly wrong: it duplicates validation, and it
checks the wrong provider. This plan deliberately does not restore it.
