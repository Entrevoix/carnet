# Implementation Report: Auto-tagging + per-mode prompt overrides

## Summary
Closed the auto-tagging gap on `journal` + `person` (every capture mode now requests semantic tags from the LLM) and added a Settings "Prompt overrides" section where the user can replace the system prompt per mode without forking the repo. All 6 planned tasks complete; no deviations beyond the type-driven extension of `FormState` to include the new overrides field.

## Assessment vs Reality

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Medium | Medium (matched) |
| Confidence | 8/10 | 9/10 — every primitive existed; the splice pattern was a clean copy-paste |
| Files Changed | 5-7 | 5 (matched low end) |
| New tests | ~10 | 10 (5 helper + 2 prompts + 3 enrich integration) |
| Test count after | ~160 | 160 (exact) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | LLM tag slots on journal + person prompts | ✅ | 1 instruction line + 1 slot edit per prompt |
| 2 | `PromptOverrides` type + persistence in `settings.ts` | ✅ | New interface, extended `Settings`/`PersistedSettings`, `sanitisePromptOverrides` strips whitespace-only, `getPromptOverrides` convenience export, v1 migration produces `{}` |
| 3 | `withSystemOverride` helper + splice through all 5 enrich entry points | ✅ | Helper exported from `omniroute.ts`; `enrichIdea/Journal/Person/SharedLink` use it; `enrichSharedImage` inlines the same logic because of its multimodal user content |
| 4 | Tests (helper + prompts + integration) | ✅ | 10 new tests across 3 describe blocks |
| 5 | Settings UI section for prompt overrides | ✅ | Inline expand/collapse rows with `TextInput multiline`, "Copy default" + "Reset to default" buttons, monospace input style, HelperText warning about injection guard / frontmatter format |
| 6 | Validate (typecheck + tests) | ✅ | tsc clean; 160/160 across 6 files |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `tsc --noEmit` clean |
| Unit Tests | ✅ Pass | 160/160; 10 new this PR |
| Build | ✅ Pass | (typecheck IS the build for this JS-only diff) |
| Integration | N/A | No integration harness for RN screens |
| Edge Cases | ✅ Pass | empty/whitespace override → default; trim preserved; override per-mode isolation tested |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/prompts.ts` | UPDATED | +9 / -2 (journal + person prompt edits) |
| `apps/mobile/src/lib/settings.ts` | UPDATED | +46 / -8 (new type + sanitisation + getPromptOverrides) |
| `apps/mobile/src/lib/omniroute.ts` | UPDATED | +66 / -33 (helper + 5 splice points + import + minor restructure) |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATED | +111 (10 new tests + import + 2 fixture patches) |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATED | +138 (PROMPT_MODES const, defaultPromptFor helper, FormState extension, render block, styles) |

## Deviations from Plan
- **FormState extended to include `promptOverrides`** (Task 5 spillback). The plan had this in Task 5 only, but the type-error during Task 2 made it cleaner to extend FormState at the same time as the type — the alternative (placeholder `{}` to be replaced later) would have wiped user overrides on every save during the intermediate state. Net effect: same code, different commit timing.
- **`enrichSharedImage` doesn't use `withSystemOverride`** but inlines the equivalent splice. Plan called this out as required — the multimodal user content is `OpenAIMessage[]`, not a `PromptPair`, so the helper wouldn't fit. 4-line inline copy keeps it DRY at the rule level even if not at the helper level.

## Issues Encountered

1. **Stale type errors at intermediate edit states** — adding `promptOverrides` as a required field on `Settings` broke `SettingsScreen.tsx:115` (save() literal) and `omniroute.test.ts:275, 288` (HTTPS-enforcement fixtures). Both fixed in the same pass. Standard fan-out of a required-field add.
2. **`PromptOverrides` import was unused** in `omniroute.ts` after extracting the helper — TypeScript's `noUnusedLocals` flagged it. Removed the import; the type is inferred from `getPromptOverrides()`'s return type at the call sites. No behavioral change.
3. **Per-test mock signature** — the existing `getSettings` mock at the top of `omniroute.test.ts` was missing `promptOverrides` and didn't expose `getPromptOverrides` at all. Extended the `vi.mock("./settings", ...)` factory to include both. All 24 existing tests continued to pass.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/omniroute.test.ts` (extended) | +10 | 5 × `withSystemOverride` (undefined/empty/whitespace/real/trim); 2 × prompt rendering (journal + person tag-slot + instruction line); 3 × enrich override flow (idea with override flows through; idea with empty override = default; journal-vs-idea per-mode isolation) |

## Manual Validation Hand-off

Pure JS change — **R, R on the dev client** to reload.

11-point checklist:
- [ ] Capture a Journal entry → frontmatter has `tags: [journal, X, Y]` with 2-3 LLM-suggested tags drawn from the content
- [ ] Capture a Person → `tags: [person, networking, X, Y]`
- [ ] Settings → scroll → "Prompt overrides" section visible
- [ ] Tap "Idea" row → expands → empty editor + "(using default)" status
- [ ] Tap "Copy default" → editor populated with the default prompt; "Reset to default" button appears
- [ ] Type changes → Save → next Idea capture uses the customized prompt
- [ ] Tap "Reset to default" → editor clears; next capture uses the default again
- [ ] Set a deliberately-broken Idea prompt (delete frontmatter format) → capture an idea → stub fallback fires → degraded banner shows → existing "Re-enrich" still works (still uses the broken override; user resets to recover)
- [ ] Set different overrides for Idea + Journal → capture both → each uses its own override (no cross-contamination)
- [ ] Image / Link / Text shares still work with default prompts
- [ ] No regression in any of the 4 capture flows

## Next Steps
- `/code-review` for a self-review pass
- `/prp-commit` + `/prp-pr` against `main`
- On-device walk after PR lands

## Follow-ups (NOT in this PR)
- Re-enrich button for `kind: idea|journal|person` — slate item; PR #9 only supports image-based re-enrich
- A "default prompt" preview view for users who want to see the current default WITHOUT copying it into the editor
- A read-only confirmation that the override is in effect (banner: "Idea capture currently uses your custom prompt")
- Per-mode model overrides (different mode → different LLM) — bigger config surface; defer
- Lint / linter for broken overrides (warn if INJECTION_GUARD removed) — premature; stub-fallback covers the failure mode
