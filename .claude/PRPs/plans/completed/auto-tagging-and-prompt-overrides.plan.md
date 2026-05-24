# Plan: Close auto-tagging gap + per-mode prompt overrides (slate #3)

## Summary
Two coupled changes. First, close the auto-tagging gap on the two capture modes that still hardcode their tags (`journal`, `person`) so every saved note has LLM-generated semantic tags alongside the kind/system tags. Second, add a Settings section that lets the user override the system prompt per capture mode — the carnet wedge is "self-hosted LLM, your prompts, your choice," so the user shouldn't have to fork the repo to tune them.

## User Story
As a carnet user with strong opinions about how my notes should read,
I want every capture to get a few semantic tags AND I want to tune the prompts that produce them,
So that I don't have to manually tag every note in Obsidian and so my notes sound like *me*, not like a generic LLM curator.

## Problem → Solution
**Current:** `idea`, `photo`/`shared-image`, `shared-link`/`shared-text` already request 2-5 LLM-generated tags. `journal` ships `tags: [journal]` only. `person` ships `tags: [person, networking]` only. All five prompts are baked into `prompts.ts` and only changeable by forking the code.

**Desired:** All five modes auto-tag. Settings has a "Prompt overrides" section where the user can paste a replacement system prompt for any mode; if set, the omniroute entry point uses the override instead of the default. Empty override means "use the default" (the normal case).

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A — slate item #3 from the market-research feature menu
- **PRD Phase:** v0.3
- **Estimated Files:** 5-7 modified + ~10 new tests
- **Confidence Score:** 8/10 — prompt edits are tiny; the Settings extension + the splice through omniroute.ts are well-understood

---

## UX Design

### Settings — new section
```
[ Settings (existing) ]
  OmniRoute URL: …
  OmniRoute API key: ●●●● configured
  Capture folder: …

[ NEW: Prompt overrides ]
  Edit the system prompt each capture mode sends to OmniRoute.
  Leave a section empty to use the default. Defaults still apply on first launch.

  ▶ Idea           (using default)        [ Customize ]
  ▶ Journal        (using default)        [ Customize ]
  ▶ Contact        (using default)        [ Customize ]
  ▶ Photo + Image  (using default)        [ Customize ]
  ▶ Link + Text    (using default)        [ Customize ]

(When expanded, the section shows:)
  ┌────────────────────────────────────────┐
  │ System prompt (multiline editor)       │
  │ <pre-filled with the default on first  │
  │  customize>                            │
  │                                        │
  └────────────────────────────────────────┘
   [Reset to default]              [Save]

  ⚠ Heads up: prompts include an injection guard + frontmatter format.
    If you remove those, OmniRoute output may break the writer (and
    drop you to a stub note). The default text is recoverable any
    time via "Reset to default".
```

### Note frontmatter — journal + person, after
```yaml
# Journal (before)              # Journal (after)
tags: [journal]                  tags: [journal, {tag1}, {tag2}]

# Person (before)                # Person (after)
tags: [person, networking]       tags: [person, networking, {tag1}, {tag2}]
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Journal capture | `tags: [journal]` | `tags: [journal, …]` with 2-3 LLM tags | Same prompt shape, extra instruction line |
| Person capture | `tags: [person, networking]` | `tags: [person, networking, …]` with 2-3 LLM tags | Same |
| Settings → Prompt overrides | section doesn't exist | new section with 5 per-mode editors | Default-empty = no behavior change |
| Saved override → next capture | — | overrides replace the system prompt for that mode | User message + injection delimiter shape unchanged |
| Bad override (e.g. wrong format) | — | OmniRoute response misses the expected frontmatter; existing stub-fallback fires; degraded banner shows | No new failure mode introduced |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/prompts.ts` | 1-267 | All five `buildXxxPrompt` functions; the gap is in journal + person |
| P0 | `apps/mobile/src/lib/omniroute.ts` | 300-460 | `enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage`, `enrichSharedLink` — the splice points |
| P0 | `apps/mobile/src/lib/settings.ts` | 1-172 | `Settings` interface + `PersistedSettings` shape + `readPersisted`/`writePersisted` — add the override map |
| P0 | `apps/mobile/src/screens/SettingsScreen.tsx` | (read full) | Where the new section mounts; existing form pattern to mirror |
| P1 | `apps/mobile/src/lib/prompts.test.ts` (if exists) | all | Existing test patterns for prompts |
| P1 | `apps/mobile/src/lib/omniroute.test.ts` | 1-50 | Test mocks + setup for omniroute |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Journal prompt with tags hardcoded | `prompts.ts:74` | `tags: [journal]` — add tag slots |
| Person prompt with tags hardcoded | `prompts.ts:108` | `tags: [person, networking]` — add tag slots |
| `chatCompletion(baseUrl, apiKey, model, promptPair)` | `omniroute.ts:~320` (in each enrich function) | Splice point: replace `buildXxxPrompt(...)` call with override-aware version |
| Settings interface | `settings.ts:19-28` | Add `promptOverrides: Partial<Record<Mode, string>>` field |
| PersistedSettings | `settings.ts:30-34` | Mirror the override field; sanitize at write |
| Settings UI form rows | `SettingsScreen.tsx` | TextInput multiline; Reset button pattern |
| Default fallback in omniroute | not yet exists | New helper `withPromptOverride(default, override)` returns the system to use |

---

## Patterns to Mirror

### JOURNAL_PROMPT_TAG_SLOT
```ts
// SOURCE: prompts.ts:74 (current — to be edited)
tags: [journal]
```
After:
```ts
tags: [journal, {tag1}, {tag2}]
```
And in the instruction list above the format:
```
+ 5. Suggest 2-3 relevant tags drawn from the content (subject matter, mood,
+    people referenced — whatever's most useful for finding this later).
```

### PERSON_PROMPT_TAG_SLOT
Same shape — add a tag-request line + `{tag1}, {tag2}` slots in the frontmatter template.

### OVERRIDE_SPLICE_POINT
```ts
// SOURCE: omniroute.ts:317-323 (current `enrichIdea`)
export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(), getApiKey(), getModel(),
  ]);
  return chatCompletion(baseUrl, apiKey, model, buildIdeaPrompt(text));
}
```
After:
```ts
export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(), getApiKey(), getModel(), getPromptOverrides(),
  ]);
  const defaultPair = buildIdeaPrompt(text);
  const pair = withSystemOverride(defaultPair, overrides.idea);
  return chatCompletion(baseUrl, apiKey, model, pair);
}
```
Mirror for `enrichJournal`, `enrichPerson`, `enrichSharedLink`. `enrichSharedImage` uses a multimodal user message — splice the system separately:
```ts
const { system: defaultSystem, userText } = buildSharedImagePrompt(input.context);
const system = overrides.sharedImage?.trim() || defaultSystem;
const messages: OpenAIMessage[] = [
  { role: "system", content: system },
  // ... existing multimodal user content ...
];
```

### NEW_HELPER (omniroute.ts or a new prompts-helper file)
```ts
/** If `override` is a non-empty string, replace the system message in `pair`
 * with it. Otherwise return `pair` unchanged. Centralizes the "user-edited
 * prompt wins; otherwise default" rule so all five enrich functions stay
 * consistent. */
export function withSystemOverride(
  pair: PromptPair,
  override: string | undefined,
): PromptPair {
  const trimmed = override?.trim() ?? "";
  if (!trimmed) return pair;
  return { system: trimmed, user: pair.user };
}
```

### SETTINGS_EXTENSION
```ts
// SOURCE: settings.ts:19-28
export interface Settings {
  omniRouteUrl: string;
  omniRouteApiKey: string;
  omniRouteModel: string;
  captureFolderPath: string;
+ promptOverrides: PromptOverrides;
}
+
+ export interface PromptOverrides {
+   idea?: string;
+   journal?: string;
+   person?: string;
+   sharedImage?: string;
+   sharedLink?: string;
+ }
```
Add a `getPromptOverrides()` convenience export that returns just the overrides (saves the splice points from loading the full Settings every enrich call):
```ts
export async function getPromptOverrides(): Promise<PromptOverrides> {
  const persisted = await readPersisted();
  return persisted.promptOverrides ?? {};
}
```

`PersistedSettings` mirrors the field. `writePersisted` sanitises (strip whitespace-only strings) so we don't store noise.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/prompts.ts` | UPDATE | Add tag slots to journal + person system prompts |
| `apps/mobile/src/lib/prompts.test.ts` | CREATE (if missing) or UPDATE | Test that the rendered prompt mentions tag slots + the instruction line |
| `apps/mobile/src/lib/omniroute.ts` | UPDATE | Splice `withSystemOverride` into all five enrich entry points; export the helper + a `getPromptOverrides`-style import |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATE | Test that an override flows through; default-empty does not change behavior |
| `apps/mobile/src/lib/settings.ts` | UPDATE | Add `PromptOverrides` type + field + `getPromptOverrides` export; sanitise on write |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | New "Prompt overrides" section with 5 collapsible per-mode editors |

## NOT Building
- **A prompt diff viewer / changelog of edits** — out of scope; user can paste their override into a separate doc if they want history.
- **A "share my prompt" library** — would need cloud storage; carnet is local-first.
- **Per-mode model overrides** — different mode → different model. Bigger config surface; defer.
- **A prompt-validation linter** — tempting (warn if missing `${INJECTION_GUARD}` / frontmatter), but the failure mode is already covered by stub-fallback. Premature.
- **Migrating existing notes** — only NEW captures get the new tags; old journal/person notes stay as-is. User can re-run them through carnet if they want updates (no current flow for that; could be a future "re-enrich" extension).
- **Re-enrich button gated on `kind: journal|person|idea`** — slate item; that's a separate PR. (PR #9 only supports image-based re-enrich.)

---

## Step-by-Step Tasks

### Task 1: Add tag slots to journal + person prompts
- **ACTION:** Edit `apps/mobile/src/lib/prompts.ts`.
- **IMPLEMENT:**
  - In `buildJournalPrompt` add a numbered instruction "Suggest 2-3 relevant tags drawn from the content (subjects, mood, people)" + change `tags: [journal]` → `tags: [journal, {tag1}, {tag2}]`.
  - In `buildPersonPrompt` add the same instruction + change `tags: [person, networking]` → `tags: [person, networking, {tag1}, {tag2}]`.
- **MIRROR:** the existing `idea` prompt's tag-request structure (instruction + slot in the frontmatter template).
- **GOTCHA:** Don't change the order of `tags:` array elements — `[journal, ...]` not `[..., journal]` so downstream Obsidian tag-search by `journal` still works.
- **VALIDATE:** Task 4 tests.

### Task 2: Add `PromptOverrides` type + persistence to `settings.ts`
- **ACTION:** Edit `apps/mobile/src/lib/settings.ts`.
- **IMPLEMENT:** per the `SETTINGS_EXTENSION` snippet. Add `PromptOverrides` interface; extend `Settings` + `PersistedSettings`; update `readPersisted`/`writePersisted` to include the field (defaults to `{}`); add `getPromptOverrides(): Promise<PromptOverrides>` for the omniroute entry points.
- **MIRROR:** the existing settings shape — keep DEFAULT_PERSISTED + the v1 migration path untouched (migration produces `promptOverrides: {}`).
- **GOTCHA:**
  - `writePersisted` should drop whitespace-only override strings so `{idea: "   "}` doesn't pollute the store.
  - The Settings UI reads + writes the full Settings object — make sure `saveSettings` round-trips overrides.
- **VALIDATE:** Task 4 tests (add to existing `settings.test.ts` if it exists; otherwise inline assertions are acceptable).

### Task 3: Splice overrides through `omniroute.ts`
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.ts`.
- **IMPLEMENT:** Add the `withSystemOverride(pair, override)` helper export. Modify all five enrich entry points (`enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage`, `enrichSharedLink`) to load overrides via `getPromptOverrides()` in parallel with the existing baseUrl/apiKey/model reads, then apply `withSystemOverride` (or the equivalent splice for the multimodal `sharedImage` path).
- **MIRROR:** `OVERRIDE_SPLICE_POINT` snippet for the simple text path; the inline pattern in the snippet for `sharedImage`.
- **IMPORTS:** add `getPromptOverrides` to the settings import line.
- **GOTCHA:**
  - Each enrich call now does ONE more AsyncStorage read for the overrides. That's a small but real cost — accept it; the existing baseUrl/apiKey/model reads dominate.
  - If `withSystemOverride` is called with an override that's identical to the default, it still works (just no-op in spirit). No special-case needed.
- **VALIDATE:** Task 4 tests verify both code paths (default + override).

### Task 4: Tests
- **ACTION:** Extend `omniroute.test.ts` with override cases; add tests for `withSystemOverride` directly (it's a pure helper).
- **IMPLEMENT:**
  - `withSystemOverride` unit tests: empty override → returns pair unchanged; whitespace override → returns pair unchanged; real override → swaps system, leaves user untouched.
  - `enrichIdea` (and at least one mode that uses the multimodal path, e.g. `enrichSharedImage`) integration tests: stub `getSettings` to return an override → the chatCompletion mock receives the overridden system message.
  - `buildJournalPrompt` + `buildPersonPrompt` rendering tests: assert the output contains `{tag1}, {tag2}` and the instruction line about suggesting tags.
- **VALIDATE:** `npm -w @carnet/mobile run test` — expect prior 150 + ~10 new = ~160 passing.

### Task 5: Settings UI section for prompt overrides
- **ACTION:** Edit `apps/mobile/src/screens/SettingsScreen.tsx`.
- **IMPLEMENT:**
  - New Card: "Prompt overrides — edit how OmniRoute structures each capture mode."
  - 5 per-mode rows, each collapsible (`List.Accordion` from Paper or a simple expand/collapse via state).
  - When expanded: multiline `TextInput` (numberOfLines={12}) pre-filled with the current override OR — if empty — the default prompt as a read-only placeholder ("Tap to start editing" via a "Customize" button that copies the default into the input).
  - Below the input: `[Reset to default]` button (clears the override) + `[Save]` button (writes via `saveSettings`).
  - HelperText warning about the injection guard + frontmatter format below the input.
  - Status pill in the collapsed row showing "using default" or "customized" so the user can see at a glance.
- **MIRROR:** the existing OmniRoute URL / API key / capture folder row patterns in `SettingsScreen.tsx`.
- **GOTCHA:**
  - Need a way to surface the default prompt text in the UI. Either (a) re-export each `buildXxxPrompt`'s system-half as a parameterless string from `prompts.ts`, or (b) call `buildXxxPrompt("placeholder")` and take the `.system` field, ignoring `.user`. Option (b) requires no API change. Use it.
  - When the user opens "Customize" on a never-edited mode, copy the default into the input as a starting point — they're tweaking, not writing from scratch.
- **VALIDATE:** Task 6 manual flow.

### Task 6: Validation
- **ACTION:** `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`.
- **VALIDATE:** clean typecheck, ~160 tests pass, no regressions.

### Task 7: On-device hand-off
- **ACTION:** R, R on the dev client (pure JS change, no rebuild needed).
- **VALIDATE:** see Manual Validation list below.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| `withSystemOverride` empty | pair, `""` | pair unchanged | yes |
| `withSystemOverride` whitespace | pair, `"   "` | pair unchanged | yes |
| `withSystemOverride` undefined | pair, undefined | pair unchanged | yes |
| `withSystemOverride` real | pair, "custom" | new pair with system = "custom" | no |
| `buildJournalPrompt` includes tag slots | transcript | output system contains `{tag1}, {tag2}` and "Suggest 2-3 relevant tags" | no |
| `buildPersonPrompt` includes tag slots | OCR + ctx | output system contains `{tag1}, {tag2}` and the tag-request instruction | no |
| `enrichIdea` with no override | any | chatCompletion receives the default buildIdeaPrompt's system | no |
| `enrichIdea` with override set | any | chatCompletion receives the override as system; user message unchanged | no |
| `enrichSharedImage` with override set | any | OpenAIMessage[]'s system is the override; user multimodal unchanged | no |
| Settings `getPromptOverrides` empty store | — | `{}` | yes |
| Settings round-trip with overrides | save then load | overrides preserved | no |
| Settings sanitises whitespace overrides | save `{idea: "   "}` | reloaded `idea` is empty / absent | yes |

### Edge Cases Checklist
- [x] User saves an override that's identical to the default → still works, no-op behaviorally
- [x] User saves an empty override → equivalent to "use default"
- [x] User saves an override missing INJECTION_GUARD → OmniRoute may produce malformed output → stub fallback fires → existing degraded-banner behavior shows
- [x] Override file gets corrupted in AsyncStorage → `getPromptOverrides` returns `{}` (existing JSON-parse-failure pattern)
- [x] Long override (>10 KB) → still works; chatCompletion has no input size limit beyond model context

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors, ~160/160 passing.

### On-device
```bash
npm run android  # (uses the wrapper from PR #12, no red screen)
```
EXPECT: app launches; Settings shows new "Prompt overrides" section.

### Manual Validation
- [ ] Capture a Journal entry on a fresh capture → frontmatter has `tags: [journal, …]` with 2-3 semantic tags
- [ ] Capture a Person → frontmatter has `tags: [person, networking, …]`
- [ ] Settings → Prompt overrides section is visible
- [ ] Tap a mode row → expands → shows "(using default)" + Customize button
- [ ] Tap Customize → default prompt populates the editor → user types changes → Save → next capture in that mode uses the override
- [ ] Tap Reset to default → editor clears the customization → next capture uses the default again
- [ ] Save a deliberately-broken prompt (e.g. delete the frontmatter format) → capture → OmniRoute returns garbage → stub fallback fires → existing "Re-enrich" button still works (and uses the override, which is still broken — so resetting the override is the recovery path; expected)
- [ ] No regression in image / link / text shares
- [ ] No regression in idea / journal / person captures (other than the new tag slot — tags are additive)

---

## Acceptance Criteria
- [ ] `journal` + `person` captures get 2-3 LLM-generated semantic tags appended to their base tags
- [ ] Settings has a "Prompt overrides" section with 5 per-mode collapsible editors
- [ ] Each editor supports Customize / Edit / Reset to default / Save
- [ ] Override (non-empty after trim) replaces the system prompt for that mode; empty falls back to default
- [ ] All five enrich entry points (idea, journal, person, sharedImage, sharedLink) honor overrides
- [ ] No type errors; ~160 tests passing
- [ ] No regression in existing capture flows

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User writes a broken override and confuses themselves | Medium | Capture saves a stub; existing Re-enrich won't help (it uses the same override) | HelperText warning; "Reset to default" is one tap; doc the recovery path in the section copy |
| Frontmatter format drift when the user removes the template | Medium | The writer's `extractFrontmatterField` returns null; the `kind:` routing on RecentDetail can't show Re-enrich (already handled per PR #9's `canReEnrich` gate) | Acceptable graceful-degradation |
| Settings UI gets crowded | Low | The new section is 5 rows of mostly-collapsed accordions — manageable | If it grows, split into a sub-screen later |
| AsyncStorage size pressure | Very Low | Each override could be 5-10 KB × 5 = ~50 KB max | AsyncStorage handles MB easily; no concern |
| INJECTION_GUARD removal becomes a security regression | Medium | Hostile share-intent content could subvert the LLM | Same risk window as any LLM-driven app; the warning in HelperText is the user's seatbelt |

## Notes
- The journal + person tag fix is shippable as a SEPARATE PR if the Settings UI portion blocks for any reason. The plan keeps them coupled because they share testing infrastructure (omniroute.test.ts) and the user picked the bundled option.
- Slate #6 (inline edit a capture) is the natural next item after this lands — together, "edit my note" and "edit how my notes get made" complete the Axis C surface.
- This is the third PR to touch `omniroute.ts`'s entry points (PR #7 added shared-image branches, PR #9 read-back, this one adds overrides). After this, consider extracting an `enrichWithOverride(mode, builder, ...)` helper to centralize the four-line splice if a fifth touch is foreseen.
