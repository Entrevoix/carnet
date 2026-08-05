# Plan: Enhance prose action (Recent detail)

Status: in-progress

## Summary
Add an **Enhance** action to an already-saved note that sends its prose body to a
dedicated, higher-quality LLM and rewrites the body in place — frontmatter and the
`# Title` heading untouched. Reuses the provider-list machinery already shipped in
#120–#123: a new `enhanceProviderId` setting mirrors the existing `visionProviderId`
rung so "a better llm" is a configured provider entry, not a hardcoded model id.

## User Story
As someone who journals quickly on a phone,
I want to polish an already-drafted entry with a stronger model,
So that the entry reads well later without me retyping it.

## Problem → Solution
A captured journal entry is enriched once, at capture time, by whatever model
`activeProviderId` names — typically a cheap/fast one (`gpt-4o-mini` is the shipped
default). There is no way to revisit an entry and re-run it through a better model,
and the existing re-run paths (`reEnrichNote`, `transcribeNote`) both require a
**paired binary** on disk, so a text-only journal entry has no re-run path at all.
→ A `⋮ → Enhance` row on any prose-bearing note, routed to a user-chosen provider,
replacing only the prose beneath the title.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form request + `/prp-plan` prompt argument)
- **PRD Phase**: N/A
- **Estimated Files**: 9 changed / 2 created (+5 test files)

---

## UX Design

### Before
```
┌──────────────────────────────────────┐
│ ‹ 2026-08-05 Morning walk        ⋮   │
├──────────────────────────────────────┤
│ # Morning walk                       │
│                                      │
│ went out early. it was cold. saw     │
│ the heron again by the bridge. was   │
│ good. felt better after.             │
│                                      │
│                             ( ✎ FAB )│
└──────────────────────────────────────┘
   ⋮ sheet:  Send to Karakeep · File info · Delete
             (no re-run path for a text-only note)
```

### After
```
┌──────────────────────────────────────┐
│ ‹ 2026-08-05 Morning walk        ⋮   │
├──────────────────────────────────────┤
│ # Morning walk            ← untouched│
│                                      │
│ I went out early, before the cold    │
│ had lifted. The heron was back by    │
│ the bridge. I felt better after.     │
│                                      │
│                             ( ✎ FAB )│
└──────────────────────────────────────┘
   ⋮ sheet:  ✨ Enhance      ← NEW
             Send to Karakeep · File info · Delete

   During: rows disabled (actionsBusy), spinner on the row.
   After:  Snackbar "Enhanced with {provider label}."
   Fail:   Snackbar with the reason; nothing written.
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `⋮` sheet on a journal/idea note | 3 rows | 4 rows — `Enhance` first | Gated by `canEnhance` |
| `⋮` sheet on an image/audio note | Re-enrich / Transcribe | unchanged + `Enhance` when it has prose | Additive only |
| Settings → LLM providers | Active · Fallback · Vision | + **Enhance model** picker | `null` = use active |
| Settings → Advanced · Prompt overrides | 5 modes | 6 modes (+ `Enhance prose`) | Same editor component |
| Note frontmatter | — | `enhanced: YYYY-MM-DD` stamped | Provenance; see Task 6 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/noteReprocess.ts` | 1–108 | **The** module to mirror — same shape, same `ReprocessOutcome`, same in-place rewrite |
| P0 | `apps/mobile/src/lib/dispatcher.ts` | 180–320 | `withFallbackChain`, `withFallbackMarker`, `resolveVisionProviderId` — copy this wiring |
| P0 | `apps/mobile/src/lib/llmProviders.ts` | 147–159 | `resolveVisionProvider` — the resolution-rung pattern (**but see GOTCHA in Task 2**) |
| P0 | `apps/mobile/src/lib/prompts.ts` | 1–31, 271–288 | `INJECTION_GUARD`, `PromptPair`, and `buildPromoteIdeaPrompt` (the only other rewrite-an-existing-note prompt) |
| P0 | `apps/mobile/src/lib/frontmatter.ts` | 116–152 | `stripFrontmatter` / `splitFrontmatter` — the header/body split this feature depends on |
| P1 | `apps/mobile/src/lib/settings.ts` | 56–190, 240–260, 320–400 | `PromptOverrides`, `Settings`, `PersistedSettings`, `sanitisePromptOverrides`, migration + defaults |
| P1 | `apps/mobile/src/lib/llmClient.ts` | 738–758 | `promoteIdea` — smallest existing call, exact shape to copy |
| P1 | `apps/mobile/src/components/NoteActionsSheet.tsx` | 1–119 | Row markup, gating props, `actionsBusy`/`missing` conventions |
| P1 | `apps/mobile/src/lib/recentDetailView.ts` | 95–102 | `noteCapabilities` — where `canEnhance` goes |
| P1 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | 95–130, 270–300, 640–680 | State + ref-guard + snackbar + sheet wiring to mirror |
| P2 | `apps/mobile/src/lib/noteReprocess.test.ts` | 1–55 | Test scaffold: `vi.mock` of `./writer` + `./dispatcher`, real-shape pure splicers |
| P2 | `apps/mobile/src/lib/enrichSanitize.ts` | 76–178 | `sanitizeMarkdown` — strips ``` fences off LLM output |
| P2 | `apps/mobile/src/components/PromptOverridesSection.tsx` | 15–41 | `PROMPT_MODES` + `defaultPromptFor` — both need the 6th entry |

## External Documentation

None needed — the feature composes existing internal modules only. No new package,
no new API surface, no SDK version question. (Deliberate: adding a native dep is
blocked in this build env anyway — see the `build-env-no-google-maven-fetch` note.)

---

## Patterns to Mirror

### PROMPT_BUILDER
```ts
// SOURCE: apps/mobile/src/lib/prompts.ts:271-288
/** Prompt for promoting an idea's status. */
export function buildPromoteIdeaPrompt(
  currentMarkdown: string,
  target: "seedling" | "developing" | "mature",
): PromptPair {
  const system = `You are a personal knowledge assistant. ...

${INJECTION_GUARD}

Respond ONLY with the complete updated Obsidian markdown (keep the frontmatter
format identical, just change status and optionally expand the body).`;
  const user = `<USER_INPUT>\n${currentMarkdown}\n</USER_INPUT>`;
  return { system, user };
}
```

### PROVIDER_RESOLUTION_RUNG
```ts
// SOURCE: apps/mobile/src/lib/llmProviders.ts:147-159
export function resolveVisionProvider(
  providers: readonly LlmProvider[],
  activeProviderId: string,
  visionProviderId: string | null = null,
): LlmProvider | null {
  const active = resolveActiveProvider(providers, activeProviderId);
  if (effectiveVisionModel(active)) return active;
  if (visionProviderId) {
    const found = providers.find((p) => p.id === visionProviderId);
    if (found && effectiveVisionModel(found)) return found;
  }
  return null;
}
```

### LLM_CLIENT_CALL
```ts
// SOURCE: apps/mobile/src/lib/llmClient.ts:738-758
export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
  config: ProviderConfig,
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  return chatCompletion(
    config.baseUrl, config.apiKey, model,
    buildPromoteIdeaPrompt(currentMarkdown, target),
    "idea", config.label,
  );
}
```

### DISPATCHER_ENTRY_POINT
```ts
// SOURCE: apps/mobile/src/lib/dispatcher.ts:281-292
export async function enrichSharedImage(input: {...}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const primaryId = resolveVisionProviderId(settings);
  const outcome = await withFallbackChain(settings, primaryId, (config) =>
    llmClient.enrichSharedImage(input, config, overrides.sharedImage),
  );
  return withFallbackMarker(outcome);
}
```

### ORCHESTRATOR_OUTCOME
```ts
// SOURCE: apps/mobile/src/lib/noteReprocess.ts:36-63
export type ReprocessOutcome =
  | { kind: "updated"; nextBody: string }
  | { kind: "failed"; reason: string };

export async function reEnrichNote(input: {
  body: string; filepath: string;
}): Promise<ReprocessOutcome> {
  try {
    const imageFilename = findPairedLink(input.body, "Photos");
    if (!imageFilename) {
      throw new Error("No paired image found in this note — ...");
    }
    // ... call, splice, updateNote ...
```

### SHEET_ROW
```tsx
// SOURCE: apps/mobile/src/components/NoteActionsSheet.tsx:63-72
{canReEnrich ? (
  <List.Item
    title="Re-enrich"
    description="Re-run AI enrichment on the original image"
    left={(p) => <List.Icon {...p} icon="auto-fix" />}
    disabled={actionsBusy}
    onPress={onReEnrich}
    style={styles.sheetRow}
  />
) : null}
```

### SCREEN_REF_GUARD
```tsx
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:277-284
if (reEnrichingRef.current) return;
reEnrichingRef.current = true;
// ...setState(true), clear error...
const outcome = await reEnrichNote({ body, filepath: entry.filepath });
// ...branch on outcome.kind...
reEnrichingRef.current = false;
```

### TEST_STRUCTURE
```ts
// SOURCE: apps/mobile/src/lib/noteReprocess.test.ts:1-33
vi.mock("./writer", () => ({
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(async () => {}),
  upsertSection: vi.fn((md, heading, body) => `${md}\n\n## ${heading}\n\n${body}\n`),
}));
vi.mock("./dispatcher", () => ({ enrichSharedImage: vi.fn(), transcribeAudio: vi.fn() }));

import { reEnrichNote } from "./noteReprocess";
const mockUpdateNote = vi.mocked(updateNote);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/prompts.ts` | UPDATE | `buildEnhanceProsePrompt()` — the 7th builder |
| `apps/mobile/src/lib/llmProviders.ts` | UPDATE | `resolveEnhanceProvider()` rung |
| `apps/mobile/src/lib/settings.ts` | UPDATE | `enhanceProviderId` + `promptOverrides.enhanceProse` + migration default |
| `apps/mobile/src/lib/llmClient.ts` | UPDATE | `enhanceProse()` call |
| `apps/mobile/src/lib/dispatcher.ts` | UPDATE | `enhanceProse()` entry point + `resolveEnhanceProviderId()` |
| `apps/mobile/src/lib/enhanceProse.ts` | CREATE | Split/call/recombine/write orchestrator |
| `apps/mobile/src/lib/enhanceProse.test.ts` | CREATE | Unit tests for the orchestrator |
| `apps/mobile/src/lib/recentDetailView.ts` | UPDATE | `canEnhance` in `noteCapabilities` |
| `apps/mobile/src/components/NoteActionsSheet.tsx` | UPDATE | `Enhance` row + props |
| `apps/mobile/src/components/PromptOverridesSection.tsx` | UPDATE | 6th prompt mode |
| `apps/mobile/src/components/LlmProviderSection.tsx` | UPDATE | "Enhance model" picker |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | State, ref guard, handler, snackbar, sheet wiring |
| `apps/mobile/src/lib/{prompts,llmProviders,settings,dispatcher,recentDetailView}.test.ts` | UPDATE | Cover each addition |

## NOT Building

- **No preview/diff-before-apply screen.** Decided: write straight through. (Revisit
  only if the destructive-overwrite risk below actually bites.)
- **No "keep the original alongside"** — no `## Original` section, no sidecar file.
- **No capture-time prose mode.** Enhance is strictly post-hoc, on a saved note.
- **No batch/bulk enhance** across many notes.
- **No new provider preset** and no hardcoded "better model" id — the user picks an
  existing provider entry. Adding a preset is a separate scope discussion.
- **No model-quality heuristics** — Carnet does not rank models; `enhanceProviderId`
  is whatever the user chose.
- **No lint-rule additions** (repo runs exactly three rules — change-controlled).

---

## Step-by-Step Tasks

### Task 1: `buildEnhanceProsePrompt` in `lib/prompts.ts`
- **ACTION**: Append a 7th builder to `prompts.ts`.
- **IMPLEMENT**:
  ```ts
  /** Prompt for enhancing the prose of an already-drafted entry. Unlike every
   * other builder here, this one returns PROSE ONLY — no frontmatter, no title,
   * no sections. lib/enhanceProse.ts owns re-attaching the header + `# Title`;
   * asking the model for them would risk it rewriting metadata it must not touch. */
  export function buildEnhanceProsePrompt(body: string): PromptPair {
    const system = `You are an expert editor and literary collaborator working on a
  personal journal entry that has already had basic grammar and formatting cleanup.
  Rewrite it into refined, expressive, compelling prose.

  1. PRESERVE THE AUTHENTIC VOICE: keep the original emotion, mood, core perspective,
     and first-person POV ("I", "we"). Never make it sound corporate, academic, or
     artificially dramatic.
  2. ABSOLUTE TRUTH FIDELITY: never invent facts, dialogue, people, events, or
     emotions that were not present or strongly implied in the source entry.
  3. ELEVATE THE PROSE: vary sentence length and structure for cadence; replace
     generic verbs and adjectives with vivid, specific language; cut filler,
     repetition, and cliché transitions; smooth disjointed thoughts into flow.
  4. RESPECT JOURNAL CONTEXT: it must still read as a personal reflection or private
     entry — not fiction, not marketing.

  ${INJECTION_GUARD}

  Output ONLY the enhanced entry text as plain markdown prose. Do NOT add a title or
  heading, do NOT add frontmatter, do NOT wrap the output in code fences, and do NOT
  add any commentary, preamble, or explanation.`;
    const user = `<USER_INPUT>\n${body}\n</USER_INPUT>`;
    return { system, user };
  }
  ```
- **MIRROR**: PROMPT_BUILDER.
- **IMPORTS**: none new (`INJECTION_GUARD` and `PromptPair` are module-local).
- **GOTCHA**: Do **not** call `todayLocal()` here — this builder must be pure w.r.t.
  the clock so its test needs no date freezing, and there is no date to emit anyway.
  The explicit "no frontmatter / no code fences / no heading" clause is load-bearing:
  every other builder in this file demands frontmatter, so a model primed on the house
  style will happily emit a `---` block that would then be spliced *inside* the body.
- **VALIDATE**: `npm -w @carnet/mobile test -- prompts` — assert the system text
  contains `INJECTION_GUARD`, contains no `---`, and that `user` wraps the body in
  `<USER_INPUT>`.

### Task 2: `resolveEnhanceProvider` in `lib/llmProviders.ts`
- **ACTION**: Add a resolution rung next to `resolveVisionProvider`.
- **IMPLEMENT**:
  ```ts
  /** Which provider serves an Enhance call:
   *   1. `enhanceProviderId`'s entry when set and it names a real entry.
   *   2. else the active entry.
   * Deliberately the INVERSE precedence of resolveVisionProvider: vision has a
   * capability test (does this entry have a vision model?) so the active entry wins
   * whenever it is capable. Enhance has no capability test — every text provider can
   * serve it — and the whole point of the setting is to reach for a BETTER model than
   * the active one, so the dedicated entry must win when set. Never returns null. */
  export function resolveEnhanceProvider(
    providers: readonly LlmProvider[],
    activeProviderId: string,
    enhanceProviderId: string | null = null,
  ): LlmProvider {
    if (enhanceProviderId) {
      const found = providers.find((p) => p.id === enhanceProviderId);
      if (found) return found;
    }
    return resolveActiveProvider(providers, activeProviderId);
  }
  ```
- **MIRROR**: PROVIDER_RESOLUTION_RUNG (shape), inverted precedence (semantics).
- **IMPORTS**: none new — `resolveActiveProvider` is module-local.
- **GOTCHA**: **Do not copy `resolveVisionProvider`'s ordering.** Copying it would
  make the active (cheap) provider win whenever it has a text model — i.e. always —
  and the Enhance setting would silently never take effect. This is the single
  easiest way to ship this feature broken and have every test still pass.
  Also: return type is `LlmProvider`, not `LlmProvider | null` — a stale
  `enhanceProviderId` (provider since deleted) falls through to active rather than
  stranding the call.
- **VALIDATE**: `npm -w @carnet/mobile test -- llmProviders` — cases: null id → active;
  set id → that entry (**even when active also has a model**); unknown id → active.

### Task 3: Settings — `enhanceProviderId` + `promptOverrides.enhanceProse`
- **ACTION**: Thread one new nullable id and one new override key through `settings.ts`.
- **IMPLEMENT**:
  - `PromptOverrides`: add `enhanceProse?: string;`
  - `Settings` + `PersistedSettings`: add
    ```ts
    /** Dedicated provider for the Enhance action. `null` = use the active entry.
     * Mirrors visionProviderId's storage shape; see resolveEnhanceProvider for the
     * (deliberately different) precedence. */
    enhanceProviderId: string | null;
    ```
  - `DEFAULT_PERSISTED`: `enhanceProviderId: null,`
  - `readPersisted()`: `enhanceProviderId: parsed.enhanceProviderId ?? null,`
  - the `saveSettings`/`getSettings` mapping blocks (~lines 391, 437, 473): pass it through.
  - `sanitisePromptOverrides` needs no change — it iterates `Object.keys(raw)`.
- **MIRROR**: every `visionProviderId` occurrence; grep it and add a sibling line at each.
- **IMPORTS**: none.
- **GOTCHA**: A persisted blob written before this change has **no** `enhanceProviderId`
  key. `?? null` in `readPersisted` is mandatory — without it the field lands
  `undefined`, and `undefined` survives `JSON.stringify` by being *dropped*, so the
  key silently never persists. Same trap the provider-list migration documents.
  Do **not** add a new migration function; this is an additive optional field.
- **VALIDATE**: `npm -w @carnet/mobile test -- settings` — round-trip save/read, plus a
  read of a legacy blob lacking the key asserting it defaults to `null`.

### Task 4: `llmClient.enhanceProse`
- **ACTION**: Add the call beneath `promoteIdea`.
- **IMPLEMENT**:
  ```ts
  /** Rewrite a note's prose body. Input and output are BODY TEXT ONLY — the caller
   * owns frontmatter and the title heading. */
  export async function enhanceProse(
    body: string,
    config: ProviderConfig,
    override?: string,
  ): Promise<EnrichResult> {
    const model = assertModelConfigured(config.model, config.label);
    assertUrlConfigured(config.baseUrl, config.label);
    return chatCompletion(
      config.baseUrl, config.apiKey, model,
      withSystemOverride(buildEnhanceProsePrompt(body), override),
      "journal", config.label,
    );
  }
  ```
- **MIRROR**: LLM_CLIENT_CALL.
- **IMPORTS**: add `buildEnhanceProsePrompt` to the existing `./prompts` import block (line ~28).
- **GOTCHA**: `promoteIdea` omits `assertUrlConfigured`; include it here (matching
  `enrichSharedLink`) so a blank base URL surfaces as not-configured rather than as a
  fetch error — the exact defect fixed in #29.
  The `"journal"` arg is the `NoteType` sanitiser tag. It is **inert for this call**
  and that is the point: `executeChat` feeds it to `sanitizeAndNormalize`, whose
  `normalizeFrontmatter` bails at `if (!header) return null` (`enrichSanitize.ts:183`)
  because prose-only output has no frontmatter block — so the per-type
  `REQUIRED_KEYS`/`CANONICAL_ORDER` tables are never consulted and no frontmatter can
  be fabricated onto the body. Any existing `NoteType` member behaves identically
  here; `"journal"` is chosen for readability. Do **not** add an `"enhance"` member —
  that would widen `NoteType` and force new entries in both tables in
  `enrichSanitize.ts` for zero behavioural gain.
- **VALIDATE**: `npm -w @carnet/mobile test -- llmClient` — asserts the model id sent,
  and that a blank base URL rejects before any fetch.

### Task 5: `dispatcher.enhanceProse`
- **ACTION**: Add the entry point + its resolver.
- **IMPLEMENT**:
  ```ts
  /** Enhance routes to enhanceProviderId when set, else the active entry. */
  function resolveEnhanceProviderId(settings: Settings): string {
    return resolveEnhanceProvider(
      settings.llmProviders, settings.activeProviderId, settings.enhanceProviderId,
    ).id;
  }

  /** Returns the raw EnrichResult — NOT fallback-marked. See GOTCHA. */
  export async function enhanceProse(body: string): Promise<EnhanceOutcome> {
    const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
    const primaryId = resolveEnhanceProviderId(settings);
    const outcome = await withFallbackChain(settings, primaryId, (config) =>
      llmClient.enhanceProse(body, config, overrides.enhanceProse),
    );
    return {
      result: outcome.result,
      usedFallback: outcome.usedFallback,
      fallbackProviderId: outcome.fallbackProviderId,
      providerLabel: resolveEnhanceProvider(
        settings.llmProviders, settings.activeProviderId, settings.enhanceProviderId,
      ).label,
    };
  }
  ```
  Export an `EnhanceOutcome` interface for that shape.
- **MIRROR**: DISPATCHER_ENTRY_POINT.
- **IMPORTS**: add `resolveEnhanceProvider` to the existing `./llmProviders` import (line 49).
- **GOTCHA**: **Do not call `withFallbackMarker` here.** It runs
  `upsertFrontmatterField` on the result markdown — but this result is *bare prose
  with no frontmatter*, so the marker would either no-op or prepend a stray `---`
  block into the middle of the note body. The marker must be applied in Task 6, after
  the header is re-attached. This is why `enhanceProse` returns the fallback fields
  outward instead of swallowing them.
- **VALIDATE**: `npm -w @carnet/mobile test -- dispatcher` — assert the config passed to
  `llmClient.enhanceProse` is built from `enhanceProviderId` when set, from active when
  null, and that the returned markdown carries **no** frontmatter marker.

### Task 6: `lib/enhanceProse.ts` (new orchestrator)
- **ACTION**: Create the module that splits, calls, recombines, and writes.
- **IMPLEMENT**:
  ```ts
  // Copyright (C) 2025 Entrevoix, Inc.
  // SPDX-License-Identifier: AGPL-3.0-only

  /**
   * Enhance a saved note's prose in place. Mirrors lib/noteReprocess.ts — same
   * outcome union, same "call, splice, updateNote" spine — but needs no paired
   * binary, so it works on a text-only journal entry.
   *
   * Frontmatter and the leading `# Title` are structurally preserved: they are
   * split off BEFORE the call and re-attached after, so the model never sees or
   * rewrites them. This keeps the byte-compatible-frontmatter constraint intact.
   */
  import { splitFrontmatter, upsertFrontmatterField } from "./frontmatter";
  import { updateNote } from "./writer";
  import { enhanceProse as dispatchEnhance } from "./dispatcher";

  export type EnhanceOutcome =
    | { kind: "updated"; nextBody: string; providerLabel: string }
    | { kind: "failed"; reason: string };

  /** Split a body into its leading `# Title` line (with trailing blanks) and the
   * prose beneath. `title` is "" when the body has no leading H1. */
  export function splitLeadingTitle(body: string): { title: string; prose: string } {
    const m = body.match(/^(#\s[^\n]*\n+)([\s\S]*)$/);
    return m ? { title: m[1], prose: m[2] } : { title: "", prose: body };
  }

  const MIN_PROSE_CHARS = 40;

  export async function enhanceNoteProse(input: {
    body: string;
    filepath: string;
  }): Promise<EnhanceOutcome> {
    try {
      const { header, body } = splitFrontmatter(input.body);
      const { title, prose } = splitLeadingTitle(body);
      if (prose.trim().length < MIN_PROSE_CHARS) {
        throw new Error("This note is too short to enhance — add some prose first.");
      }
      const outcome = await dispatchEnhance(prose);
      // Already fence-stripped AND security-sanitized upstream — see GOTCHA.
      const cleaned = outcome.result.markdown.trim();
      if (!cleaned) {
        throw new Error("The model returned nothing — the note was left unchanged.");
      }
      let next = `${header}${title}${cleaned}\n`;
      next = stampEnhanced(next, outcome);   // frontmatter provenance
      await updateNote(input.filepath, next);
      return { kind: "updated", nextBody: next, providerLabel: outcome.providerLabel };
    } catch (err: unknown) {
      return {
        kind: "failed",
        reason: err instanceof Error ? err.message : "Enhance failed.",
      };
    }
  }
  ```
  `stampEnhanced` uses `upsertFrontmatterField(next, "enhanced", todayLocalDate)` and,
  when `outcome.usedFallback`, also stamps the existing fallback field via the same
  helper `dispatcher.markFallback` uses — now safe, because `next` has frontmatter.
- **MIRROR**: ORCHESTRATOR_OUTCOME.
- **IMPORTS**: as listed above.
- **GOTCHA**: **Do not re-sanitize here.** `llmClient.executeChat` already ran the full
  gate on this string (`llmClient.ts:355-356`): `stripCodeFences(content)`, then
  `sanitizeAndNormalize(stripped, noteType) ?? sanitizeMarkdown(stripped)`. For
  prose-only output `normalizeFrontmatter` returns `null` on its very first check
  (`enrichSanitize.ts:183` — `if (!header) return null`), so the expression falls
  through to `sanitizeMarkdown`, which neutralizes Templater `<%…%>`, raw HTML, and
  dataviewjs. Net: fences are gone and executable content is inert before the value
  ever reaches this module. Calling `sanitizeMarkdown` again would be redundant, and
  reaching for it *to strip fences* would be wrong — it deliberately preserves fence
  bodies verbatim (it is a security sanitizer, not an unwrapper). A plain `.trim()`
  is the correct and sufficient step.
- **GOTCHA**: `splitFrontmatter` returns `header` **including** its trailing newline —
  verify against `frontmatter.ts:137` before concatenating, or the recombined note
  gains/loses a blank line and breaks the byte-compat constraint. A note with **no**
  frontmatter yields `header === ""`, which must still work (idea notes captured
  before Task 0 frontmatter shipped). Keep this file well under 200 lines; if
  `stampEnhanced` grows, it belongs in `frontmatter.ts`, not here.
- **VALIDATE**: `npm -w @carnet/mobile test -- enhanceProse`.

### Task 7: `canEnhance` capability gate
- **ACTION**: Extend `noteCapabilities` in `recentDetailView.ts`.
- **IMPLEMENT**: add `canEnhance: !missing` to the returned object and to the
  `NoteCapabilities` interface. Every kind qualifies — the real "is there enough
  prose?" test lives in `enhanceNoteProse` (Task 6), which owns the body text; this
  gate only knows `kind` and `missing`.
- **MIRROR**: the existing `canReEnrich` / `canTranscribe` lines (`recentDetailView.ts:99-101`).
- **IMPORTS**: none.
- **GOTCHA**: Do not gate on `kind === "journal"`. Ideas and shared-link notes have
  prose bodies too, and the user's ask was about journal entries but the capability is
  the same. Gating on `missing` is mandatory — a deleted `.md` must never be written.
- **VALIDATE**: `npm -w @carnet/mobile test -- recentDetailView`.

### Task 8: `Enhance` row in `NoteActionsSheet.tsx`
- **ACTION**: Add props `canEnhance: boolean` / `onEnhance: () => void` and a row
  **above** `Re-enrich`.
- **IMPLEMENT**:
  ```tsx
  {canEnhance ? (
    <List.Item
      title="Enhance"
      description="Rewrite this entry's prose with a stronger model"
      left={(p) => <List.Icon {...p} icon="auto-fix" />}
      disabled={actionsBusy || missing}
      onPress={onEnhance}
      style={styles.sheetRow}
    />
  ) : null}
  ```
- **MIRROR**: SHEET_ROW.
- **IMPORTS**: none.
- **GOTCHA**: `Re-enrich` already uses `icon="auto-fix"`; pick a distinct icon
  (`"feather"` or `"format-letter-case"`) so the two rows aren't visually identical on
  an image note where **both** can show. Unlike `Re-enrich`, this row must also
  disable on `missing` (it writes to disk). Do not restate colors/spacing — read
  `DESIGN.md` before touching visuals.
- **VALIDATE**: `npm -w @carnet/mobile test -- RecentDetailScreen`.

### Task 9: Wire `RecentDetailScreen.tsx`
- **ACTION**: Add state, ref guard, handler, snackbar, and pass the two new props.
- **IMPLEMENT**: mirror the `reEnriching` block exactly — `const [enhancing, setEnhancing]`,
  `const [enhanceError, setEnhanceError]`, `const enhancingRef = useRef(false)`, a
  `handleEnhance` following SCREEN_REF_GUARD that calls `enhanceNoteProse({ body, filepath })`,
  sets the body on `updated`, sets the error on `failed`, and always clears the ref.
  Add `enhancing` to the `actionsBusy` expression and to the FAB's `disabled` list
  (line ~581, alongside `reEnriching || transcribing`). Add a success Snackbar
  ("Enhanced with {providerLabel}.") beside the existing three.
- **MIRROR**: SCREEN_REF_GUARD.
- **IMPORTS**: `import { enhanceNoteProse } from "../lib/enhanceProse";`
- **GOTCHA**: This file is **739 lines** against the repo's 800 cap (CLAUDE.md's
  "~1614" is stale — it has since been reduced). Adding ~35 lines lands ≈775. Keep
  **all** logic in `lib/enhanceProse.ts`; if the screen crosses 800, extract the
  reprocess handlers into a `useNoteReprocess` hook rather than widening this file.
  The ref guard is not optional — without it a double-tap fires two concurrent writes
  to the same path.
- **VALIDATE**: `npm -w @carnet/mobile run lint` (floating-promise rule catches an
  un-`void`ed handler) + `npm -w @carnet/mobile test -- RecentDetailScreen`.

### Task 10: Settings UI — provider picker + 6th prompt override
- **ACTION**: Surface both new settings.
- **IMPLEMENT**:
  - `PromptOverridesSection.tsx`: add `{ key: "enhanceProse", label: "Enhance prose",
    icon: "feather" }` to `PROMPT_MODES`, and an `enhanceProse` case to
    `defaultPromptFor` returning `buildEnhanceProsePrompt("placeholder").system`.
  - `LlmProviderSection.tsx`: add an "Enhance model" picker mirroring the existing
    Vision-provider picker, with a "Use active provider" (`null`) option.
- **MIRROR**: the existing vision-provider picker in `LlmProviderSection.tsx`; the
  `PROMPT_MODES` table at `PromptOverridesSection.tsx:15-21`.
- **IMPORTS**: `buildEnhanceProsePrompt` into `PromptOverridesSection.tsx`'s
  `../lib/prompts` block.
- **GOTCHA**: `defaultPromptFor`'s switch has no `default` branch — it is exhaustive
  over `PromptModeKey`, so adding the key without adding the case is a **compile
  error**, not a runtime surprise. That is intentional; let `tsc` guide you.
  Watch the key-alias collision documented in memory: the picker must write
  `enhanceProviderId` only, never touch other providers' stored keys.
- **VALIDATE**: `npm -w @carnet/mobile run typecheck` + `test -- SettingsScreen`.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `buildEnhanceProsePrompt` wraps input | `"went out early"` | `user` contains `<USER_INPUT>`; `system` contains injection guard | |
| prompt forbids frontmatter | — | `system` contains no `---` and says "Output ONLY" | |
| `resolveEnhanceProvider` — null id | `(list, "omniroute", null)` | active entry | |
| `resolveEnhanceProvider` — set id | `(list, "omniroute", "openai")` | **openai** entry | ✅ precedence |
| `resolveEnhanceProvider` — stale id | `(list, "omniroute", "custom-9")` | active entry | ✅ deleted provider |
| `splitLeadingTitle` — with H1 | `"# T\n\nbody"` | `{title:"# T\n\n", prose:"body"}` | |
| `splitLeadingTitle` — no H1 | `"just prose"` | `{title:"", prose:"just prose"}` | ✅ |
| `enhanceNoteProse` happy path | body + filepath | `updateNote` called; frontmatter byte-identical | |
| `enhanceNoteProse` — no frontmatter | body with `header===""` | recombines without a stray `---` | ✅ |
| `enhanceNoteProse` — too short | `"ok."` | `{kind:"failed"}`, `updateNote` **not** called | ✅ |
| `enhanceNoteProse` — empty model output | `""` | `{kind:"failed"}`, nothing written | ✅ |
| `enhanceNoteProse` — leading/trailing blank lines | `"\n\nx\n\n"` | trimmed to `x`, exactly one trailing `\n` | ✅ |
| `llmClient` fence strip (existing behaviour) | ` ```markdown\nx\n``` ` | `EnrichResult.markdown === "x"` | ✅ upstream — assert in `llmClient.test.ts`, **not** in `enhanceProse.test.ts` (the dispatcher is mocked there, so a fence assertion would be vacuous) |
| `enhanceNoteProse` — dispatcher throws | rejects | `{kind:"failed"}` with the message | ✅ |
| settings round-trip | save `enhanceProviderId:"openai"` | reads back `"openai"` | |
| settings legacy blob | blob without the key | `null`, not `undefined` | ✅ migration |
| dispatcher routes to enhance provider | `enhanceProviderId` set | config built from that entry | ✅ |
| dispatcher output unmarked | fallback used | markdown has **no** frontmatter marker | ✅ |
| `noteCapabilities` gates on missing | `missing:true` | `canEnhance:false` | ✅ |

### Edge Cases Checklist
- [x] Empty input (empty/whitespace body → `failed`, nothing written)
- [x] Maximum size input — a very long entry; relies on the provider's own context
      limit surfacing as an API error through `chatCompletion` (already handled)
- [x] Invalid types — malformed persisted `enhanceProviderId` falls through to active
- [x] Concurrent access — `enhancingRef` guard blocks double-tap double-write
- [x] Network failure — `withFallbackChain` retries once on unreachable-class only;
      terminal failure → `failed` outcome, note untouched
- [x] Permission denied — deleted `.md` (`missing`) disables the row; a write error
      from `updateNote` is caught into `failed`

---

## Validation Commands

### Static Analysis
```bash
npm run build:shared
npm -w @carnet/mobile run typecheck
npm -w @carnet/shared run typecheck
```
EXPECT: zero type errors. `defaultPromptFor`'s exhaustive switch will fail loudly if
Task 10 is done without Task 1.

### Lint
```bash
npm -w @carnet/mobile run lint
```
EXPECT: clean. The typed `no-floating-promises` rule is the one that catches an
un-`void`ed `handleEnhance` in the screen.

### Unit Tests
```bash
npm -w @carnet/mobile test -- enhanceProse prompts llmProviders settings dispatcher
```
EXPECT: all pass.

### Full Test Suite
```bash
npm -w @carnet/mobile test
npm -w @carnet/shared test
```
EXPECT: no regressions (~600 tests today).

### Repro Harness
```bash
npm -w @carnet/mobile run verify:capture-flow
```
EXPECT: green — frontmatter round-trip fixtures must be untouched by this change.
This is the gate that proves the byte-compat constraint held.

### Database Validation
N/A — no SQLite, no DB. Persistence is AsyncStorage only (hard constraint).

### Browser Validation
N/A — React Native. Device path below.

### Manual Validation (on device)
- [ ] Settings → LLM providers → set **Enhance model** to a stronger provider; save; reopen Settings and confirm it persisted.
- [ ] Open an existing journal entry → `⋮` → **Enhance**.
- [ ] Body prose is rewritten; **frontmatter and `# Title` are byte-identical** (check via `⋮ → File info` path, or diff the file in the Syncthing folder).
- [ ] `enhanced:` frontmatter field appears exactly once; running Enhance twice does not duplicate it.
- [ ] Airplane mode → Enhance → error snackbar, note unchanged on disk.
- [ ] Leave **Enhance model** unset → Enhance still works via the active provider.
- [ ] Double-tap the row fast → only one write (ref guard).
- [ ] Confirm the resulting file still opens cleanly in Obsidian.

---

## Acceptance Criteria
- [ ] All 10 tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing for every new exported function
- [ ] No type errors
- [ ] No lint errors
- [ ] Enhance routes to `enhanceProviderId` when set (the Task 2 precedence test proves it)
- [ ] Frontmatter + `# Title` byte-identical before/after (verify:capture-flow green)
- [ ] `RecentDetailScreen.tsx` still under 800 lines

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style (outcome union, never a thrown escape)
- [ ] Logging follows codebase conventions (no `console.log`)
- [ ] Tests follow the `noteReprocess.test.ts` scaffold
- [ ] No hardcoded values (no hardcoded "better model" id)
- [ ] No mutation (all splices return new strings)
- [ ] Documentation updated — `docs/CODEMAPS/frontend.md` gains `lib/enhanceProse.ts`
- [ ] No unnecessary scope additions (see NOT Building)
- [ ] Plan `Status:` flipped to `shipped` and moved to `plans/completed/` on merge
      (CI enforces this — `scripts/check-stale-plans.sh`)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Destructive overwrite** — original prose is unrecoverable once enhanced | High (by design) | High | Explicitly chosen over preview/append. Syncthing gives file history on the workstation side; `enhanced:` stamp makes it auditable. If this bites, the preview-sheet option is a contained follow-up. |
| Copying `resolveVisionProvider`'s precedence verbatim | **High** | High | Task 2 GOTCHA + a dedicated test asserting the dedicated entry wins over a capable active entry |
| `withFallbackMarker` corrupting a frontmatter-less body | Medium | High | Task 5 GOTCHA — marker moved to Task 6, after re-attachment; test asserts no marker on dispatcher output |
| Model returns frontmatter/title anyway despite the prompt | Medium | Medium | `sanitizeMarkdown` strips fences; prompt is explicit. Consider a follow-up guard stripping a leading `---` block from the model's prose if this shows up on device. |
| `RecentDetailScreen.tsx` crosses the 800-line cap | Medium | Low | Task 9 GOTCHA — extract to a `useNoteReprocess` hook if it does |
| Legacy settings blob strands `enhanceProviderId: undefined` | Medium | Medium | `?? null` in `readPersisted` + a legacy-blob test |
| Enhance run on a note mid-edit clobbers unsaved edits | Low | Medium | Row is disabled while `actionsBusy`; the screen's existing `DiscardEditsDialog` guards the edit session |

## Deviations from this plan during implementation
Recorded so review doesn't have to rediscover them:

1. **`components/ProviderRoleRow.tsx` was extracted (not in the plan).** Adding the
   Enhance picker to `LlmProviderSection.tsx` (779 lines) would have landed it at ~819,
   over the repo's 800 ceiling. The fallback/vision/enhance rows were structurally
   identical, so they became one presentational component; the section ended at **798**.
   Styles were copied verbatim from its stylesheet so the rows render unchanged.
2. **`ProviderIdentity` gained `enhanceProviderId`** (`lib/llmProviderForm.ts`), so
   deleting a provider clears a dangling Enhance reference the way it already did for
   fallback/vision. Not in the plan; found by following the delete path.
   `resolveEnhanceProvider` already degraded gracefully, so this is consistency, not a
   crash fix — but Settings showing a deleted entry as the Enhance model is exactly the
   "recoverable but wrong to ship" case that identity group exists to prevent.
3. **`NoteBusyState`/`NoteIssueState` gained `enhancing`/`enhanceError`**, so Enhance
   participates in the shared busy row and single-banner precedence rather than adding
   parallel UI state.
4. **`splitLeadingTitle`'s regex was wrong on first write** — `/^(#[^#\S]*…)/` matched
   zero characters after the hash and so treated `## Notes` as the title. Caught by its
   own test; the H1 now requires a following space/tab (`/^(#[ \t]…)/`).
5. **Task 6 dropped the redundant `sanitizeMarkdown` call** already corrected in this
   plan before implementation — the value arrives fence-stripped and sanitized.

## Notes
- **The "better llm" requirement is a settings question, not a model question.** Carnet
  never ranks models, and the shipped provider presets carry empty `model` fields —
  the user supplies model ids. So "better" is expressed as *a provider entry the user
  designated for this purpose*, exactly as `visionProviderId` expresses "the entry that
  can see images." No hardcoded model id enters the codebase.
- **The prompt supplied in the `/prp-plan` argument is reproduced in Task 1 with two
  deliberate changes**: the injection guard was added (every other builder has one, and
  this input is note content that could itself be a hostile shared link), and the
  output rules were extended to forbid frontmatter/headings/code fences — necessary
  because the surrounding house style trains the model to emit them.
- `promptOverrides.enhanceProse` means the prompt stays user-tunable on device without
  a rebuild, which is how the other five prompts are already iterated on.
- Deliberately **not** using `noteReprocess.ts` as the home for this: that module's
  docstring scopes it to "re-run against a note's **paired binary**," and both its
  functions begin by locating one. Enhance has no binary. A sibling module keeps both
  files small and honest.
