Status: shipped

# Plan: Edit Before/After Enrichment (all capture modes)

## Summary
Add a non-mandatory "Edit" escape hatch that lets the user interrupt an in-flight
enrichment call and revise their raw text instead of accepting the LLM's output, across
all three capture modes (Idea, Journal, Person). Separately, generalize the existing
Idea-only, pending-only "Finish enrichment" action into a "Re-enrich" action available on
any note after the user edits it, for all three modes — not just notes stuck in
`pending-enrich`.

## User Story
As a Carnet user capturing a thought/journal entry/person note, I want an "Edit" button
I can tap while enrichment is running (or right after a note is saved) so I can correct or
add to what I wrote before the AI-enriched version replaces it — and I want to be able to
edit an already-saved note's raw content and manually re-run enrichment on my edit — so
that I never have to accept a wrong first-pass transcription/enrichment as a permanent
frontmatter/title/tags record.

## Problem → Solution
**Current**: In every mode, once Send is tapped, enrichment fires with zero user-facing
gap. Idea (save-first, the default) writes raw text to disk and immediately calls
`enrichIdeaInPlace` back-to-back, synchronously, with no pause. Journal and Person call
`enrichJournal`/`enrichPerson` directly and block on the result before showing anything.
The only "preview" that exists (`previewBeforeSave` setting, Idea only) previews the
*already-enriched* output, not the raw pre-LLM draft. Post-save, only Idea notes that are
still stamped `pending-enrich` (i.e., enrichment never successfully ran) can be
re-enriched at all — a normally-enriched note, or any Journal/Person note, has no
re-enrich path once saved.

**Desired**: During the enrichment-in-flight window, an "Edit" affordance is visible (not
forced — the default flow proceeds exactly as today if the user does nothing). Tapping it
returns the user to an editable draft with their raw text intact, discards/ignores the
in-flight enrichment result when it lands, and lets them resubmit. Separately, after
editing any saved note's body in `RecentDetailScreen`, a "Re-enrich" action is available
regardless of the note's enrichment status, dispatching to the correct mode's enrichment
call and applying the result with the same mtime-conflict protection Idea already has.

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 8-9 (2 new, 6-7 updated) + matching test files

---

## UX Design

### Before
```
┌────────────────────────────────────┐
│ Idea (save-first, default):        │
│  [type text] → [Send]              │
│  → raw saved instantly              │
│  → enrichment fires immediately,    │
│    no way to interrupt/edit         │
│  → "Saved" card with Re-enrich      │
│    (only if pending-enrich stalled) │
│                                      │
│ Journal / Person:                   │
│  [type/transcribe] → [Send]         │
│  → blocking spinner while           │
│    enrichJournal/enrichPerson runs  │
│  → Preview shows ENRICHED text only │
│    (nothing to edit pre-enrichment) │
└────────────────────────────────────┘
```

### After
```
┌────────────────────────────────────┐
│ All 3 modes, during "submitting":   │
│  [spinner] "Enriching…"  [Edit]     │
│   tap Edit → back to draft, text    │
│   intact, in-flight result ignored  │
│                                      │
│ RecentDetailScreen, any saved note: │
│  Edit note body → Save → tap        │
│  "Re-enrich" in the action sheet    │
│  (no longer requires pending status)│
└────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `CaptureScreen`, phase `"submitting"` | Bare spinner, no interaction | Spinner + "Edit" text button | All 3 modes |
| Idea save-first cancel-and-edit | N/A | Rewrites the SAME on-disk file via `updateNote`, does not create a duplicate | See GOTCHA below — `writeIdea` cannot be reused here |
| `NoteActionsSheet` re-enrich row | "Finish enrichment", gated on `isPendingEnrich(body)`, Idea-photo modes get a separate "Re-enrich" for `handleReEnrich` (vision) | One generalized "Re-enrich" row, gated on mode ∈ {idea, journal, person} and `!missing`, works regardless of pending status | Existing photo-vision `handleReEnrich` stays separate — different code path (`reEnrichNote`/`noteReprocess.ts`), out of scope here |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/screens/CaptureScreen.tsx` | 76-149 (state), 389-528 (submit), 368-387 (`reEnrichSaved`) | The state machine and submit flow you're modifying for all 3 modes |
| P0 | `apps/mobile/src/lib/ideaSaveFirst.ts` | 41-121 (`RawIdeaInput`, `writeRawIdea`), 123-176 (`applyEnrichedIdea`, `EnrichIdeaOutcome`), 183-208 (`enrichIdeaInPlace`) | Exact shape of the save-first write/enrich pair you're interrupting and the new `rewriteRawIdea` must mirror |
| P0 | `apps/mobile/src/lib/writer.ts` | 536-545 (`writeIdea`, always collision-suffixes, never overwrites), 113-130 (`findCollisionFreeName`), 711-713 (`updateNote`, unconditional overwrite-by-path), 758-771 (`updateNoteIfUnchanged`, the only mtime-guarded overwrite) | **Critical gotcha**: `writeIdea` cannot be called again to "save the edit" — same slug produces a NEW `-2.md` file, orphaning the original pending note |
| P0 | `apps/mobile/src/lib/finishEnrichment.ts` | full file (107 lines) | The exact pattern (mtime-baseline-before-call, re-read from disk, `isPendingEnrich` gate) the new generalized re-enrich function must extend, not replace |
| P1 | `apps/mobile/src/lib/dispatcher.ts` | 268-309 (`enrichIdea`/`enrichJournal`/`enrichPerson`/`enrichSharedImage` signatures), 203-234 (`withFallbackChain`) | Enrichment call signatures the new in-place functions call into |
| P1 | `apps/mobile/src/lib/writer.ts` | 560-563, 594 (`appendJournal`, overwrites day file, NO mtime guard), 607-616, 632-633 (`writePerson`, ALWAYS new collision-suffixed file, NO mtime guard) | Journal/Person have no existing in-place-update primitive — must be built from `updateNoteIfUnchanged` directly, not from `appendJournal`/`writePerson` |
| P1 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | 282-308 (`handleReEnrich`, `handleFinishEnrichment`), 488-491, 504-520 (`canReEnrich`/busy-state derivation), 710-747 (`NoteActionsSheet` wiring) | The action-sheet gating and shared busy/error state slot you're extending |
| P1 | `apps/mobile/src/lib/captureConfirmSave.ts` | 30-41 (`applyLocation`, `composeMarkdown`) | Frontmatter re-merge pattern (`upsertFrontmatterField`) reused by the new rewrite/in-place functions |
| P2 | `apps/mobile/src/components/DiscardEditsDialog.tsx` | full file (42 lines) | Existing confirm-dialog component/pattern — reference for styling consistency if a confirm step is added around discarding an in-flight enrichment (see Task 2 note) |
| P2 | `apps/mobile/src/lib/ideaSaveFirst.test.ts` | 1-80 | Mock setup pattern (`vi.mock("./settings")`, `expo-file-system/legacy` in-memory fs with mtime clock) to replicate for new tests |
| P2 | `apps/mobile/src/lib/noteReprocess.test.ts` | 1-32 | Minimal `lib/*.ts` orchestrator test pattern (mock `./writer` + `./dispatcher`, `vi.clearAllMocks()` in `beforeEach`) |
| P2 | `apps/mobile/src/screens/CaptureScreen.test.tsx` | 1-100 | Screen-level test mock pattern (jsdom, `PaperProvider`, `vi.mock("../lib/dispatcher")`, `vi.mock("../lib/ideaSaveFirst")`) |

## External Documentation
No external research needed — feature uses established internal patterns (mtime-guarded
overwrite, `kind`-discriminated outcome unions, Paper `Snackbar`/`Banner`/`HelperText`).

---

## Patterns to Mirror

### PHASE_STATE_MACHINE
// SOURCE: apps/mobile/src/screens/CaptureScreen.tsx:76, 103
```ts
type Phase = "input" | "submitting" | "preview" | "saved";
const [phase, setPhase] = useState<Phase>("input");
```
All other capture facts are sibling `useState` calls, not nested in `Phase`. Add
`"editing-draft"`... actually — **do not add a new phase name**; the edit-cancel action
just sets `phase` back to `"input"`. This mirrors the existing pattern where every
transition is a flat `setPhase(...)` call, no reducer.

### OUTCOME_DISCRIMINATED_UNION
// SOURCE: apps/mobile/src/lib/ideaSaveFirst.ts:171-176
```ts
export type EnrichIdeaOutcome =
  | { kind: "updated"; markdown: string }
  | { kind: "conflict" }
  | { kind: "failed"; transient: boolean; reason: string };
```
Any new outcome type (e.g. for `reEnrichNoteInPlace`) MUST use `kind` as the discriminant
field name (never `status`/`type`) — this is uniform across `ReprocessOutcome`,
`FinishEnrichmentOutcome`, `EnrichIdeaOutcome`.

### MTIME_GUARDED_INPLACE_UPDATE
// SOURCE: apps/mobile/src/lib/ideaSaveFirst.ts:141-149, 183-208
```ts
export async function applyEnrichedIdea(input: ApplyEnrichedIdeaInput) {
  const markdown = /* re-merge attachments/tags/location onto LLM output */;
  const { ok } = await updateNoteIfUnchanged(input.filepath, markdown, input.expectedMtime);
  return ok ? { status: "updated" as const, markdown } : { status: "conflict" as const };
}
```
// SOURCE: apps/mobile/src/lib/finishEnrichment.ts:56-58
```ts
// Baseline first — a baseline read after the call would match whatever the
// edit produced, making the guard useless for the window it exists to cover.
const baseline = await getModificationTime(input.filepath);
```
This ordering (read mtime baseline BEFORE the LLM call, not before the user starts
editing) is the established convention — `enhanceProse.ts` and `promoteIdeaOnDisk.ts`
both follow it too. Any new in-place function must follow it exactly.

### IN_PLACE_OVERWRITE_NOT_WRITE
// SOURCE: apps/mobile/src/lib/writer.ts:536-545, 113-130
```ts
export async function writeIdea(slug: string, markdown: string) {
  const filename = await findCollisionFreeName(ideasUri, slug, ".md", root.fs); // bumps to -2, -3…
  const filepath = await writeNewFile(ideasUri, filename, markdown, root.fs);
  return { filepath };
}
```
**GOTCHA**: `writeIdea` always creates a new/differently-named file if the slug already
exists — it is NOT idempotent-overwrite. `deriveRawIdeaSlug` (ideaSaveFirst.ts:67-74) is
derived purely from the first line of raw text, so editing the text changes the slug.
Calling `writeRawIdea` again after an edit would silently orphan the original
`pending-enrich` file as a duplicate. The new "resubmit after edit-cancel" path for Idea
MUST target the ORIGINAL `filepath` directly via `updateNote(filepath, markdown)`
(writer.ts:711-713, unconditional overwrite-by-path) — never call `writeIdea` a second
time for the same capture session.

### ACTION_SHEET_GATING
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:716 (approx, `canFinishEnrichment`)
```ts
canFinishEnrichment={!missing && isPendingEnrich(body)}
```
The new generalized gate should read `canReEnrich={!missing && isReEnrichableMode(entry.mode)}`
— a small pure helper, not inlined — following the existing `noteCapabilities(...)`-style
derivation already used for `canReEnrich` (vision) at lines 488-491.

### SHARED_BUSY_ERROR_SLOT
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:282-308, 504-520
```ts
const handleFinishEnrichment = useCallback(async () => {
  if (reEnrichingRef.current) return;
  reEnrichingRef.current = true;
  setReEnrichError(null);
  setReEnriching(true);
  const outcome = await finishPendingEnrichment({ body, filepath: entry.filepath });
  if (outcome.kind === "updated") setBody(outcome.nextBody);
  else setReEnrichError(outcome.reason);
  reEnrichingRef.current = false;
  setReEnriching(false);
}, [body, entry.filepath]);
```
The new generalized re-enrich handler reuses this SAME `reEnrichingRef`/`reEnriching`/
`reEnrichError` slot (comment at lines 294-297 explains why: mutually exclusive actions
share one busy-state to keep `NoteActionsSheet` wiring unchanged) rather than adding new
state.

### ERROR_SURFACING
// SOURCE: apps/mobile/src/screens/CaptureScreen.tsx:704-708 (HelperText, form-blocking)
// SOURCE: apps/mobile/src/screens/RecentDetailScreen.tsx:555-559 (Banner, single-slot)
```tsx
{error && <HelperText type="error" visible>{error}</HelperText>}
```
```tsx
{!missing && activeIssue ? <Banner visible icon="alert" actions={[]}>{activeIssue}</Banner> : null}
```
Errors always go through `HelperText`/`Banner`; `Snackbar` (RecentDetailScreen.tsx:671-708)
is reserved for success/info toasts only — never for hard failures. Error narrowing is
always `e instanceof Error ? e.message : String(e)`.

### TEST_MOCK_SETUP
// SOURCE: apps/mobile/src/lib/noteReprocess.test.ts:6-32
```ts
vi.mock("./writer", () => ({
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(async () => {}),
  injectImageEmbed: vi.fn((md, rel) => `![](${rel})\n\n${md}`),
  upsertSection: vi.fn((md, heading, body) => `${md}\n\n## ${heading}\n\n${body}\n`),
}));
vi.mock("./dispatcher", () => ({ enrichSharedImage: vi.fn(), transcribeAudio: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
```
Minimal, representative pattern for a pure `lib/*.ts` orchestrator test.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/ideaSaveFirst.ts` | UPDATE | Add exported `rewriteRawIdea(input)` — overwrites the ORIGINAL filepath via `updateNote`, returns a fresh mtime baseline, mirrors `writeRawIdea` but targets an existing path |
| `apps/mobile/src/lib/journalPersonInPlace.ts` | CREATE | New `enrichJournalInPlace`/`enrichPersonInPlace` functions mirroring `applyEnrichedIdea`/`enrichIdeaInPlace`, using `updateNoteIfUnchanged` (Journal/Person currently have zero mtime-guarded in-place update capability) |
| `apps/mobile/src/lib/finishEnrichment.ts` | UPDATE | Add exported `reEnrichNoteInPlace(input: { body: string; filepath: string; mode: CaptureMode })` — mode-dispatches to Idea's `enrichIdeaInPlace`-based path (relaxing the `isPendingEnrich` requirement) or the new Journal/Person in-place functions. Keep `finishPendingEnrichment`/`isPendingEnrich` unchanged (still used for the pending-specific UI copy) |
| `apps/mobile/src/screens/CaptureScreen.tsx` | UPDATE | Add `enrichAbortedRef`, an "Edit" action visible during `phase === "submitting"` for all 3 modes, restore text/tags/location/attachments on cancel, guard async continuations, wire Idea's cancel-then-resubmit to `rewriteRawIdea` when re-editing a save-first draft |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | Generalize `canFinishEnrichment` → `canReEnrich` (mode-gated, not pending-gated), dispatch to `reEnrichNoteInPlace`, keep vision `handleReEnrich` untouched |
| `apps/mobile/src/components/NoteActionsSheet.tsx` | UPDATE | Rename/relabel the action row conditionally ("Finish enrichment" when `isPendingEnrich`, "Re-enrich" otherwise), update prop types |
| `apps/mobile/src/lib/ideaSaveFirst.test.ts` | UPDATE | Add tests for `rewriteRawIdea` (overwrite-in-place, mtime bump) |
| `apps/mobile/src/lib/journalPersonInPlace.test.ts` | CREATE | Tests for the two new in-place functions (success, mtime conflict, LLM failure) |
| `apps/mobile/src/lib/finishEnrichment.test.ts` | CREATE (if not already present — verify during Task 1) | Tests for `reEnrichNoteInPlace` mode dispatch |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` | UPDATE | Add tests for the Edit-during-submitting affordance across all 3 modes, including the late-arriving-enrichment-is-ignored guard |
| `apps/mobile/src/screens/RecentDetailScreen.test.tsx` | UPDATE | Add tests for the generalized `canReEnrich` gating and the relabeled action |

## NOT Building
- Plus Codes / location geocoding (explicitly out of scope per user decision this session)
- EXIF metadata extraction from photos (explicitly out of scope per user decision this session)
- A mandatory/forced review step before any enrichment call — the Edit action is always a
  non-blocking, optional escape hatch, never a gate the user must dismiss
- Changes to the vision-photo `handleReEnrich`/`reEnrichNote`/`noteReprocess.ts` path — it
  is mode-gated separately and untouched by this plan
- Editing during the blocking `previewBeforeSave` flow's preview step (that already shows
  editable enriched markdown before save — out of scope, already solved)
- Real cancellation of the in-flight network request — the LLM call is allowed to run to
  completion; only its UI/disk effects are suppressed via the ref guard + mtime guard

---

## Step-by-Step Tasks

### Task 1: Verify `finishEnrichment.test.ts` existence and `NoteActionsSheet` current props
- **ACTION**: Before writing new code, run `find apps/mobile/src -name "finishEnrichment.test.ts"` and read `apps/mobile/src/components/NoteActionsSheet.tsx` in full (not yet read in this plan's research) to get its exact prop interface.
- **IMPLEMENT**: N/A — this is a verification-only task the plan's research did not cover (only `NoteActionsSheet`'s call sites were confirmed, not its own prop definitions).
- **MIRROR**: N/A
- **IMPORTS**: N/A
- **GOTCHA**: If `finishEnrichment.test.ts` already exists, extend it — do not create a duplicate file (adjust "Files to Change" action from CREATE to UPDATE accordingly).
- **VALIDATE**: You can state the exact current `NoteActionsSheetProps` shape and whether `onFinishEnrichment`/`onReEnrich` are already optional or required props.

### Task 2: Add `rewriteRawIdea` to `ideaSaveFirst.ts`
- **ACTION**: Add an exported function that overwrites an EXISTING raw-idea file in place (for the edit-then-resubmit case), distinct from `writeRawIdea` which always creates a new file.
- **IMPLEMENT**:
  ```ts
  export interface RewriteRawIdeaInput extends RawIdeaInput {
    filepath: string;
  }
  export interface RewriteRawIdeaResult {
    filepath: string;
    mtime: number;
    markdown: string;
  }
  export async function rewriteRawIdea(
    input: RewriteRawIdeaInput,
    now?: Date,
  ): Promise<RewriteRawIdeaResult> {
    const markdown = buildRawIdeaMarkdown(input, now); // reuse existing builder, ideaSaveFirst.ts:85-94
    await updateNote(input.filepath, markdown); // writer.ts:711-713 — unconditional overwrite by path
    const mtime = await getModificationTime(input.filepath);
    return { filepath: input.filepath, mtime, markdown };
  }
  ```
- **MIRROR**: `writeRawIdea` (ideaSaveFirst.ts:112-121) for the read-back-mtime pattern; `buildRawIdeaMarkdown` (ideaSaveFirst.ts:85-94) is reused unchanged.
- **IMPORTS**: `updateNote` from `./writer` (writer.ts:711-713) — new import in this file.
- **GOTCHA**: Do NOT call `deriveRawIdeaSlug`/`writeIdea` here — that path creates a new file. This function must always take the caller-supplied `filepath` of the note being edited.
- **VALIDATE**: `npm -w @carnet/mobile test -- ideaSaveFirst` — new test: write a raw idea, call `rewriteRawIdea` with edited text at the same filepath, assert the file content changed and `mtime` increased, and assert no second file was created (list the Ideas dir mock and check length === 1).

### Task 3: Create `journalPersonInPlace.ts`
- **ACTION**: Build the missing mtime-guarded in-place update primitive for Journal and Person, mirroring Idea's `applyEnrichedIdea`/`enrichIdeaInPlace` pair.
- **IMPLEMENT**:
  ```ts
  export type EnrichInPlaceOutcome =
    | { kind: "updated"; markdown: string }
    | { kind: "conflict" }
    | { kind: "failed"; transient: boolean; reason: string };

  export async function enrichJournalInPlace(input: {
    filepath: string;
    expectedMtime: number;
    transcript: string;
    notes: string;
  }): Promise<EnrichInPlaceOutcome> {
    // call dispatcher.enrichJournal({transcript, notes}); classify failures the same
    // way enrichIdeaInPlace does (isNotConfiguredError/isPermanentError, ideaSaveFirst.ts:190-196);
    // on success, updateNoteIfUnchanged(filepath, result.markdown, expectedMtime)
  }

  export async function enrichPersonInPlace(input: {
    filepath: string;
    expectedMtime: number;
    ocrResult: string;
    context: string;
  }): Promise<EnrichInPlaceOutcome> { /* same shape */ }
  ```
- **MIRROR**: `enrichIdeaInPlace` (ideaSaveFirst.ts:183-208) for the failure-classification and outcome-mapping shape exactly, including the `kind` discriminant.
- **IMPORTS**: `enrichJournal`, `enrichPerson`, `isNotConfiguredError`, `isPermanentError` from `./dispatcher`; `updateNoteIfUnchanged`, `getModificationTime` from `./writer`.
- **GOTCHA**: Neither `appendJournal` nor `writePerson` should be called from this file — both create/append rather than idempotently overwrite (see IN_PLACE_OVERWRITE_NOT_WRITE pattern above). Go straight to `updateNoteIfUnchanged` with the caller's `filepath`.
- **VALIDATE**: `npm -w @carnet/mobile test -- journalPersonInPlace` — cover: success path, mtime-conflict path (pre-seed a stale mtime), and both permanent and transient dispatcher failures.

### Task 4: Add `reEnrichNoteInPlace` to `finishEnrichment.ts`
- **ACTION**: Add a mode-dispatching generalized re-enrich function that does NOT require `pending-enrich` status, for use from `RecentDetailScreen`.
- **IMPLEMENT**:
  ```ts
  export async function reEnrichNoteInPlace(input: {
    body: string;
    filepath: string;
    mode: CaptureMode;
  }): Promise<FinishEnrichmentOutcome> {
    const baseline = await getModificationTime(input.filepath); // baseline BEFORE any LLM call
    let source = input.body;
    try { source = await readNote(input.filepath); } catch { /* fall back to snapshot */ }

    if (input.mode === "idea") {
      const text = stripFrontmatter(source).trim();
      if (!text) return { kind: "failed", reason: "This note has no text to enrich." };
      const outcome = await enrichIdeaInPlace({
        filepath: input.filepath, expectedMtime: baseline, text,
        tags: getFrontmatterTags(source),
        location: extractFrontmatterField(source, "location") ?? undefined,
      });
      return mapEnrichIdeaOutcome(outcome); // small local mapper to FinishEnrichmentOutcome
    }
    if (input.mode === "journal") {
      const outcome = await enrichJournalInPlace({
        filepath: input.filepath, expectedMtime: baseline,
        transcript: stripFrontmatter(source).trim(), notes: "",
      });
      return mapEnrichInPlaceOutcome(outcome);
    }
    if (input.mode === "person") {
      const outcome = await enrichPersonInPlace({
        filepath: input.filepath, expectedMtime: baseline,
        ocrResult: stripFrontmatter(source).trim(), context: "",
      });
      return mapEnrichInPlaceOutcome(outcome);
    }
    return { kind: "failed", reason: "This note type cannot be re-enriched." };
  }
  ```
- **MIRROR**: `finishPendingEnrichment` (finishEnrichment.ts:51-107) for the baseline-first, re-read-from-disk, never-throw structure — but drop its `isPendingEnrich` gate entirely for this new function (keep the old one for the pending-specific UI copy).
- **IMPORTS**: `enrichJournalInPlace`, `enrichPersonInPlace` from `./journalPersonInPlace` (Task 3); existing `enrichIdeaInPlace` import stays.
- **GOTCHA**: Re-running Idea enrichment on an ALREADY-enriched body (not raw text) feeds LLM-formatted prose back into a prompt designed for raw input — this is expected/accepted behavior for this feature (the user explicitly asked to be able to re-enrich after editing an enriched note), but flag it in the PR description; do not attempt to detect/special-case "already enriched" bodies — treat whatever is currently on disk as the input, exactly like `enhanceProse.ts` and `handleReEnrich` (vision) already do.
- **VALIDATE**: `npm -w @carnet/mobile test -- finishEnrichment` — one test per mode (idea/journal/person), plus one for an unsupported mode returning the `"failed"` fallback.

### Task 5: Add the "Edit" affordance during `phase === "submitting"` in `CaptureScreen.tsx`
- **ACTION**: For all three modes, render a small "Edit" text button alongside the existing loading spinner, and wire it to abort the pending enrichment's UI effect and restore the draft.
- **IMPLEMENT**:
  ```ts
  const enrichAbortedRef = useRef(false);
  // In the Journal/Person submit() calls (lines ~481, ~506) and the Idea save-first
  // enrichIdeaInPlace call (lines ~459-466): set enrichAbortedRef.current = false right
  // before firing, then at the START of the .then()/await-continuation that applies the
  // result, check `if (enrichAbortedRef.current) { enrichAbortedRef.current = false; return; }`
  // before any setPhase/setPending/setError call.

  const editInstead = useCallback(() => {
    enrichAbortedRef.current = true;
    if (mode === "idea" && saveFirstCtxRef.current) {
      // Idea save-first: restore text/tags/location/pending from the stashed ctx,
      // remember the filepath so the next submit uses rewriteRawIdea (Task 2) instead
      // of writeRawIdea.
      const ctx = saveFirstCtxRef.current;
      setText(ctx.text);
      setTags(ctx.tags.join(", ")); // match whatever the tags input's string shape is — verify at CaptureScreen.tsx:107ish
      setLocation(ctx.location ?? null);
      setEditingFilepath(savedFilepath); // new state, see below
    }
    // Journal/Person: text/transcript/ocrText were never cleared pre-preview, so
    // nothing to restore — just flip phase back.
    setPhase("input");
  }, [mode, savedFilepath]);
  ```
  Add `const [editingFilepath, setEditingFilepath] = useState<string | null>(null);` near
  the other capture state (around line 149). In `submit()`'s Idea save-first branch
  (~line 428-466): if `editingFilepath` is set, call `rewriteRawIdea({ filepath:
  editingFilepath, text, tags, location, attachments })` instead of `writeRawIdea`, then
  clear `editingFilepath` after the write succeeds.
- **MIRROR**: `reEnrichSaved` (CaptureScreen.tsx:368-387) for the `saveFirstCtxRef`
  read-back pattern; the existing `HelperText`/spinner block (~lines 640-660,
  704-708) for where to slot the new button visually.
- **IMPORTS**: `rewriteRawIdea` from `../lib/ideaSaveFirst` (Task 2).
- **GOTCHA**: The mtime-guard in `applyEnrichedIdea`/`updateNoteIfUnchanged` already
  prevents the ORIGINAL in-flight `enrichIdeaInPlace` call from clobbering the file after
  `rewriteRawIdea` bumps its mtime — but that is a DATA-level guard only. Without the
  `enrichAbortedRef` UI-level guard, the original call's resolved promise would still
  flip `phase`/show a stale "conflict" or success notice on top of the screen the user has
  already navigated back into edit mode on. Both guards are required, not just one.
- **VALIDATE**: `npm -w @carnet/mobile test -- CaptureScreen` — for each mode: start
  submit, tap Edit before the mocked enrichment promise resolves, assert `phase ===
  "input"` and the text field shows the original draft; then resolve the mocked promise
  and assert no further phase/state change occurred (the abort guard fired).

### Task 6: Generalize re-enrich gating in `RecentDetailScreen.tsx`
- **ACTION**: Replace the pending-only `canFinishEnrichment` gate with a mode-based
  `canReEnrich` gate, and dispatch to the new `reEnrichNoteInPlace` (Task 4).
- **IMPLEMENT**:
  ```ts
  const canReEnrichGeneral = !missing && isReEnrichableMode(entry.mode); // new pure helper
  const handleGeneralReEnrich = useCallback(async () => {
    if (reEnrichingRef.current) return;
    reEnrichingRef.current = true;
    setReEnrichError(null);
    setReEnriching(true);
    const outcome = await reEnrichNoteInPlace({ body, filepath: entry.filepath, mode: entry.mode });
    if (outcome.kind === "updated") setBody(outcome.markdown);
    else setReEnrichError(outcome.reason);
    reEnrichingRef.current = false;
    setReEnriching(false);
  }, [body, entry.filepath, entry.mode]);
  ```
  Keep `handleFinishEnrichment`/`canFinishEnrichment` as-is for the specifically
  pending-enrich UI copy ("Finish enrichment" reads better than "Re-enrich" when the note
  has literally never been enriched) — pass BOTH capabilities to `NoteActionsSheet` and
  let it choose the label (Task 7), rather than collapsing them into one handler.
- **MIRROR**: `handleFinishEnrichment` (RecentDetailScreen.tsx:298-308) exactly, for the
  shared `reEnrichingRef`/`reEnriching`/`reEnrichError` slot (SHARED_BUSY_ERROR_SLOT
  pattern above) — all three re-enrich-family actions (`handleReEnrich` vision,
  `handleFinishEnrichment`, `handleGeneralReEnrich`) must stay mutually exclusive via the
  same ref.
- **IMPORTS**: `reEnrichNoteInPlace` from `../lib/finishEnrichment` (Task 4).
- **GOTCHA**: `entry.mode` needs an `isReEnrichableMode` check because not every
  `CaptureMode` value necessarily maps to an in-place enrich function (verify the full
  `CaptureMode` union in `lib/storage.ts` during implementation — Task 1's Mandatory
  Reading list didn't include it; confirm no 4th mode exists before assuming
  idea/journal/person is exhaustive).
- **VALIDATE**: `npm -w @carnet/mobile test -- RecentDetailScreen` — assert
  `canReEnrichGeneral` is true for a normally-enriched Idea note (previously it would have
  been false since `isPendingEnrich` would be false), and that tapping the action calls
  `reEnrichNoteInPlace` with the current (possibly just-edited) `body`.

### Task 7: Update `NoteActionsSheet.tsx` labeling/props
- **ACTION**: Accept both `onFinishEnrichment`/`canFinishEnrichment` (existing, keep) and
  new `onGeneralReEnrich`/`canReEnrichGeneral` (Task 6) props; render one row that prefers
  the pending-specific "Finish enrichment" label/handler when `canFinishEnrichment` is
  true, otherwise falls back to "Re-enrich" wired to `onGeneralReEnrich` when
  `canReEnrichGeneral` is true. Never render both rows at once for the same note.
- **IMPLEMENT**: Exact prop shape depends on Task 1's verification of the current file —
  do not guess the interface; extend it following the existing prop-naming convention
  (`&lt;ComponentName&gt;Props`, per the E section naming convention already established).
- **MIRROR**: Whatever pattern the existing `onReEnrich`/`canReEnrich` (vision) prop pair
  already uses in this file — match its shape exactly for the new pair.
- **IMPORTS**: N/A (pure prop/render change).
- **GOTCHA**: Three re-enrich-family rows can now theoretically all apply to the same
  note in edge cases (e.g., a pending-enrich Idea note that also happens to be
  photo-backed) — confirm the mutual-exclusivity condition explicitly rather than relying
  on incidental gating; a pending-enrich note should show "Finish enrichment", not both
  "Finish enrichment" and "Re-enrich".
- **VALIDATE**: Manual: open a normally-enriched Idea note → action sheet shows
  "Re-enrich" only. Open a `pending-enrich` Idea note → shows "Finish enrichment" only.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `rewriteRawIdea` overwrites same file | edited text, original filepath | file content updated, mtime increased, no `-2.md` created | — |
| `enrichJournalInPlace` success | valid transcript, matching mtime | `{ kind: "updated", markdown }` | — |
| `enrichJournalInPlace` conflict | stale `expectedMtime` | `{ kind: "conflict" }` | Yes — concurrent edit |
| `enrichPersonInPlace` transient failure | dispatcher throws network error | `{ kind: "failed", transient: true, reason }` | Yes |
| `reEnrichNoteInPlace` mode dispatch | mode = "idea"/"journal"/"person" | routes to the correct in-place function | — |
| `reEnrichNoteInPlace` unsupported mode | mode outside the known set | `{ kind: "failed", reason: "..." }` | Yes |
| CaptureScreen Edit-during-submitting (Idea) | tap Edit before mocked enrich resolves | `phase === "input"`, text restored, late resolution ignored | Yes — race condition |
| CaptureScreen Edit-during-submitting (Journal/Person) | tap Edit before mocked enrich resolves | `phase === "input"`, transcript/ocrText intact | Yes |
| RecentDetailScreen `canReEnrichGeneral` | normally-enriched Idea note | `true` (was `false` before this change) | Regression guard |
| RecentDetailScreen action-sheet mutual exclusivity | pending-enrich note | only "Finish enrichment" row renders | Yes |

### Edge Cases Checklist
- [ ] Empty input — Edit tapped with an already-empty draft (Idea save-first clears fields
      before enrichment fires; restoring from `saveFirstCtxRef` must repopulate correctly)
- [ ] Maximum size input — n/a, no new size constraints introduced
- [ ] Invalid types — n/a, no new external input parsing
- [ ] Concurrent access — mtime-conflict path for all three new in-place functions (see
      unit tests above); a Syncthing-synced edit landing during the enrichment window
- [ ] Network failure — dispatcher throwing during `enrichJournalInPlace`/
      `enrichPersonInPlace`, verify `isNotConfiguredError`/`isPermanentError`
      classification is reused correctly (not re-implemented ad hoc)
- [ ] Permission denied — n/a, no new filesystem permission surface
- [ ] Double-tap Edit or double-tap Re-enrich — verify `enrichAbortedRef` and
      `reEnrichingRef` guards prevent duplicate in-flight calls

---

## Validation Commands

### Static Analysis
```bash
npm run build:shared
npm -w @carnet/mobile run typecheck
```
EXPECT: Zero type errors

### Unit Tests
```bash
npm -w @carnet/mobile test -- ideaSaveFirst journalPersonInPlace finishEnrichment CaptureScreen RecentDetailScreen
```
EXPECT: All tests pass, including new ones added in Tasks 2-7

### Full Test Suite
```bash
npm -w @carnet/mobile test
npm -w @carnet/mobile run verify:capture-flow
```
EXPECT: No regressions; capture-flow fixture subset still green

### Lint
```bash
npm -w @carnet/mobile run lint
```
EXPECT: Zero violations (only 3 rules exist in this repo — floating promises is the one
most likely to trip on the new async handlers; make sure every `void handleX()` /
`await`-in-callback site is explicit)

### Manual Validation
- [ ] Idea (save-first, default): capture a note, tap Edit during the brief
      submitting/enriching window, verify the draft reappears with original text, edit it,
      resubmit, verify only ONE file exists in `Ideas/` for this capture (no `-2.md`)
- [ ] Journal: same Edit-during-submitting flow, verify transcript/notes are intact after
      tapping Edit
- [ ] Person: same flow with OCR text
- [ ] RecentDetailScreen: open a normally-enriched Idea note, edit its body, save, tap
      "Re-enrich" in the action sheet, verify the note updates and the mtime-conflict path
      is exercised if you edit again mid-enrichment
- [ ] RecentDetailScreen: open a `pending-enrich` note, verify it still shows "Finish
      enrichment" (not "Re-enrich") and behaves exactly as before this change
- [ ] Verify on-device (Pixel, per project memory — a real ADB-connected device is
      available in this environment) since this touches capture UX directly

---

## Acceptance Criteria
- [ ] All 7 tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing for every new function and UI path
- [ ] No type errors
- [ ] No lint errors
- [ ] Matches UX design: Edit action is non-blocking/optional in all 3 modes; Re-enrich is
      available regardless of pending status

## Completion Checklist
- [ ] Code follows discovered patterns (outcome unions use `kind`, mtime-baseline-before-call,
      error surfacing via HelperText/Banner not Alert)
- [ ] Error handling matches codebase style (`e instanceof Error ? e.message : String(e)`)
- [ ] No hardcoded values
- [ ] No unnecessary scope additions — Plus Codes / EXIF / vision re-enrich untouched
- [ ] Self-contained — Task 1's verification items resolved before continuing to Tasks 2+

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `writeIdea` reuse mistake orphans duplicate files | Medium (easy to reach for the familiar function) | Medium — clutters vault with `-2.md` dead files | Task 2's explicit GOTCHA + test asserting only one file exists |
| Re-enriching an already-enriched body degrades quality (LLM re-processing its own prior output) | Medium | Low-Medium — user-initiated, reversible via vault history/Syncthing, but could surprise users | Explicitly accepted in Task 4's GOTCHA; consider surfacing a one-line warning in the action sheet copy during implementation (not a blocking requirement) |
| UI-level abort guard (`enrichAbortedRef`) forgotten on one of the 3 modes, causing a stale enrichment result to silently overwrite an in-progress edit | Medium | High — silent data loss of the user's edit | Task 5 test matrix explicitly covers all 3 modes' abort-then-late-resolution case |
| `CaptureMode` union has a 4th value not accounted for in `isReEnrichableMode` | Low | Low — falls through to `{ kind: "failed" }`, no crash | Task 6 GOTCHA calls out verifying the full union before assuming exhaustiveness |
| Journal's `updateNoteIfUnchanged` conflicts more often than Idea's, since `appendJournal` is a shared day-file (multiple entries per file) rather than one-note-per-file | Medium | Medium — more frequent "conflict, try again" UX for Journal re-enrich specifically | Out of scope to fix the underlying day-file granularity; document as a known limitation in the PR description |

## Notes
This plan deliberately does not touch Plus Codes location support or EXIF metadata
extraction — both were raised in the same planning conversation but explicitly descoped by
the user to keep this plan focused. If picked up later, `apps/mobile/src/lib/location.ts`
(Plus Codes) and the photo-attachment paths in `PhotoCaptureScreen.tsx`/`attachments.ts`
(EXIF) are the relevant entry points per this session's initial research pass.
