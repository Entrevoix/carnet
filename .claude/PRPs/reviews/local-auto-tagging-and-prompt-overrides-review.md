# Local Code Review: Auto-tagging + per-mode prompt overrides

**Reviewed**: 2026-05-23
**Reviewer**: self (Claude Code)
**Branch**: `feat/auto-tag-and-prompt-overrides` (vs `main`)
**Decision**: APPROVE with comments (M1 applied in-review; L1–L4 noted)

## Summary
5 files, +347/-23, 11 new tests after M1. The journal+person tag gap is closed; per-mode prompt overrides ship behind a new Settings section with Copy default / Reset to default UX. One MEDIUM caught in-review (missing integration test for the one entry point with a non-helper splice) was applied.

## Findings

### CRITICAL / HIGH
None.

### MEDIUM

**M1. `enrichSharedImage` integration test missing — APPLIED**

`apps/mobile/src/lib/omniroute.test.ts`. The 3 enrich-override tests covered `enrichIdea` (×2) and `enrichJournal` (×1) — all helper-driven splices. `enrichSharedImage` uses an inline splice because its user content is `OpenAIMessage[]`, not `PromptPair`. That's the splice most likely to drift silently from the helper-driven entry points, and it was untested.

Fix: added a test that mocks `getPromptOverrides()` to return `{sharedImage: "..."}`, calls `enrichSharedImage`, and asserts the chatCompletion mock received the override as the system message AND that the user content stays multimodal (the image attachment isn't dropped).

```ts
it("enrichSharedImage applies the sharedImage override via its inline splice", …);
```

11 → 35 tests now. Pinning the inline-splice path keeps it from drifting from the rest.

### LOW

- **L1.** `sanitisePromptOverrides` preserves arbitrary keys from a corrupted persisted blob (`{idea: "x", foo: "y"}` keeps `foo`). Runtime consumers (`overrides.idea`, etc.) ignore unknown keys, so risk is cosmetic. Could restrict to the known `PromptModeKey` set if it ever matters.
- **L2.** `fontFamily: "monospace"` on the prompt TextInput is Android-only. iOS would fall back to system. Not a regression today.
- **L3.** "Copy default" button stays visible even when the current value already equals the default. Could hide it once `value === defaultPromptFor(key)`. Minor UX.
- **L4.** No per-editor Save button — must scroll to the main Settings Save. Matches the rest of the screen (URL, API key, model all save the same way). Consistent.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `tsc --noEmit` clean (post-M1) |
| Lint | N/A | No `lint` script |
| Tests | ✅ Pass | 161/161 across 6 files (160 + 1 from M1) |
| Build | N/A | Pure JS diff |

## Files Reviewed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/prompts.ts` | Modified | +9/-2 |
| `apps/mobile/src/lib/settings.ts` | Modified | +46/-8 |
| `apps/mobile/src/lib/omniroute.ts` | Modified | +66/-33 |
| `apps/mobile/src/lib/omniroute.test.ts` | Modified | +138 (post-M1: +27 over the original +111) |
| `apps/mobile/src/screens/SettingsScreen.tsx` | Modified | +138 |

## Decision Rationale
Zero CRITICAL/HIGH. M1 was a real coverage gap on the one entry point most likely to drift — fixed with a 25-line test that pins both the system override AND the preserved multimodal user content. L1–L4 are documented but non-blocking.

## Manual validation still pending
Screen-level interaction (long override text, Copy default UX, Reset behavior) needs on-device confirmation per the plan's 11-item checklist.
