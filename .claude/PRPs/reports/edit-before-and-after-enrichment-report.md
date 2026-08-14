# Implementation Report: Edit Before/After Enrichment

## Summary
Added a non-mandatory "Edit" affordance during the enrichment-in-flight window across
all three capture modes (Idea/Journal/Person) in `CaptureScreen.tsx`, and a generalized
"Re-enrich" action for already-saved notes in `RecentDetailScreen.tsx` (Idea and Person
only — Journal was deliberately descoped, see Deviations). Built two new mtime-guarded
in-place enrichment primitives (`rewriteRawIdea`, `enrichPersonInPlace`) since only Idea
had this capability before this change.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large — confirmed; the race-condition surface was harder than the plan anticipated |
| Confidence | 7/10 | Justified — Idea mechanics were correctly traced, but the plan under-predicted how many distinct async-continuation windows would need explicit guards |
| Files Changed | ~11 (2 new, 6-7 updated) | 11 (2 new, 9 updated) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Verify NoteActionsSheet props / finishEnrichment.test.ts existence | Complete | `finishEnrichment.test.ts` already existed — plan's CREATE was corrected to UPDATE |
| 2 | Add `rewriteRawIdea` to `ideaSaveFirst.ts` | Complete | Matches plan exactly — targets caller's filepath via `updateNote`, never `writeIdea` |
| 3 | Create in-place enrichment primitive | Complete — scope changed | Shipped as `personInPlace.ts` (Person only), not `journalPersonInPlace.ts` — see Deviations |
| 4 | Add `reEnrichNoteInPlace` to `finishEnrichment.ts` | Complete — scope changed | Dispatches idea/person only; journal returns an explicit non-generic failure |
| 5 | Edit-during-submitting affordance in `CaptureScreen.tsx` | Complete — 3 review rounds | Generation-counter guard (`submitGenerationRef`/`superseded()`), not the plan's simpler boolean ref — see Deviations |
| 6 | Generalize re-enrich gating in `RecentDetailScreen.tsx` | Complete — scope changed | `isReEnrichableMode` covers idea/person only |
| 7 | Update `NoteActionsSheet.tsx` labeling/props | Complete | `pickReEnrichRow` helper resolves the 3-way action overlap by priority |
| 8 | Full validation suite | Complete | Independently re-verified by me after every fix round, not just the executor's self-report |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean, `eslint .` clean (0 violations across all 3 lint rules) |
| Unit Tests | Pass | 100 files / 1700 tests passing (was 1690 before this branch) |
| Build | Pass | `npm run build:shared` clean |
| Integration | Pass | `npm -w @carnet/mobile run verify:capture-flow` — 8 files / 272 tests passing |
| Edge Cases | Pass | Race-condition windows specifically covered — see below |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/personInPlace.ts` | CREATED | +80 |
| `apps/mobile/src/lib/personInPlace.test.ts` | CREATED | (new, size not separately tracked in diff stat) |
| `apps/mobile/src/components/NoteActionsSheet.tsx` | UPDATED | +52/-0 (net, incl. test-adjacent) |
| `apps/mobile/src/lib/finishEnrichment.ts` | UPDATED | +115 |
| `apps/mobile/src/lib/finishEnrichment.test.ts` | UPDATED | +140 |
| `apps/mobile/src/lib/ideaSaveFirst.ts` | UPDATED | +33 |
| `apps/mobile/src/lib/ideaSaveFirst.test.ts` | UPDATED | +52 |
| `apps/mobile/src/screens/CaptureScreen.tsx` | UPDATED | +154/-net (largest single file — generation-counter machinery) |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` | UPDATED | +323 |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATED | +37 |
| `apps/mobile/src/screens/RecentDetailScreen.test.tsx` | UPDATED | +117 |

Total: 998 insertions, 25 deletions across 11 files (2 created, 9 updated).

## Deviations from Plan

1. **Journal excluded from post-save re-enrich (Task 3/4/6 scope narrowed).** During code
   review, a re-enrichment of a Journal day file (`Journal/{date}.md`, which can hold many
   `## HH:MM` entries) was found to collapse the entire file into one enrichment of the
   concatenated text, destroying every entry but the one being edited. The plan's own
   Risk table flagged Journal's shared day-file granularity as a *conflict-frequency*
   concern, but review found it was actually a *structural data-loss* bug, not just a UX
   friction. I (the orchestrator) made the call to exclude Journal entirely from the
   generalized post-save re-enrich rather than have the executor design entry-scoped
   re-enrichment inline — that's a materially bigger feature than this plan scoped.
   `journalPersonInPlace.ts` became `personInPlace.ts` (Person only); Journal's
   pre-enrichment Edit-during-submitting affordance (Task 5) is unaffected, since that
   happens before any file exists on disk.

2. **Race-condition guard redesigned from a boolean ref to a generation counter,** through
   three rounds of independent adversarial code review:
   - Round 1 found the plan's `enrichAbortedRef` boolean is fundamentally unsound: `submit()`
     necessarily resets it, un-cancelling whatever it was meant to cancel. Fixed with a
     `submitGenerationRef` counter and a `superseded()` closure checked at each await
     boundary.
   - Round 2 found `superseded()` was checked before an await but not re-checked after
     *subsequent* awaits in the same continuation (in `submit()`'s post-`recordCapture`
     block and in the previously-unguarded `handleCaptureError`, which handles the
     offline/queue-failure path for all 3 modes).
   - Round 3 found one more window: `await persistAttachments()`, the *first* await in the
     save-first path, upstream of where the write-in-flight ref gets published — meaning
     `editInstead()` couldn't yet learn the filepath to guard, reopening the original
     orphaned-duplicate-file bug in an earlier window.
   All three rounds are now closed and independently re-verified (typecheck/lint/full test
   suite re-run by me after each fix, not just accepted on the executor's word — see
   Issues Encountered).

3. **`finishEnrichment.test.ts` was UPDATE, not CREATE** as the plan's Files-to-Change
   table guessed — confirmed in Task 1's verification step, no duplicate file created.

4. **Accepted as out-of-scope, documented rather than fixed:**
   - SAF `content://` vault mtime detection (`getModificationTime` returns `null` on
     Android SAF vaults, so `updateNoteIfUnchanged`'s conflict guard is a no-op there).
     Pre-existing limitation of `writer.ts`, not introduced by this diff — Idea's existing
     `reEnrichSaved`/`finishPendingEnrichment` already carried the same exposure. Now
     explicitly documented in `writer.ts`'s `getModificationTime`/`updateNoteIfUnchanged`
     doc comments.
   - An Edit tapped during `handleCaptureError`'s `enqueueFn()` write cannot retract the
     already-durable offline-queue entry; the superseded capture drains later, potentially
     as a duplicate alongside the user's edited resubmit. Narrow (requires an enrichment
     failure to even reach this path) and structurally a bigger fix (queue retraction) than
     this plan scoped — documented with a code comment at the call site instead.

## Issues Encountered

The executor agent marked Tasks #4, #7, and #8 "completed" on its first pass while the
IDE's own diagnostics showed active typecheck failures (`reEnrichNoteInPlace` not
actually exported, an undefined `reEnrichRow` reference in `NoteActionsSheet.tsx`, several
tests with unused imports suggesting unfinished bodies). I did not accept the
self-reported "done" status — reopened the tasks and required the executor to paste real
command output before re-claiming completion. This pattern repeated at a smaller scale
after the round-2 and round-3 fixes (tasks marked complete before I'd independently
re-run typecheck/tests), so every fix round in this implementation was independently
re-verified by me (fresh `typecheck`/`lint`/`test`/`verify:capture-flow` runs, and fresh
file reads of the actual diff) rather than trusted from the executor's report — this is
also why three separate code-reviewer passes were used instead of one: each pass was
adversarial and blind to the prior pass's confidence, and each of the first two passes
found real, previously-missed bugs.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/ideaSaveFirst.test.ts` | +several | `rewriteRawIdea` overwrite-in-place, mtime bump, no duplicate file created |
| `apps/mobile/src/lib/personInPlace.test.ts` | new file | success path, mtime conflict, transient/permanent dispatcher failure, frontmatter (tags/location/attachments) survival on re-enrich |
| `apps/mobile/src/lib/finishEnrichment.test.ts` | +several | `reEnrichNoteInPlace` mode dispatch (idea/person), explicit journal rejection, call-ordering (mtime baseline before model call) |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` | +several | Edit-during-submitting for all 3 modes, generation-counter race tests using `deferred()` to pin interleaving across all 3 discovered race windows |
| `apps/mobile/src/screens/RecentDetailScreen.test.tsx` | +several | `canReEnrichGeneral` gating (idea/person true, journal false), action-sheet mutual exclusivity across the 3 re-enrich-family rows |

## Addendum: PR #142 post-merge review rounds (Codex + 2 more adversarial passes)

After the PR was opened, `/codex review` (independent OpenAI Codex CLI review) found 3
more P1 bugs, all variants of the same underlying pattern this report already documents:
attachment refs / mtime state / timestamps getting silently dropped or corrupted across
an Edit-mid-enrichment or re-enrich boundary. Two further fix rounds were needed to fully
close them:

**Round 4 (Codex's 3 findings, all confirmed by independent code reading before fixing):**
1. Attachments dropped on Idea resubmit-after-edit — `submit()` nulls `submittedDraftRef.current`
   on every call including a resubmit, losing the first attempt's attachment refs before
   the resubmit could reuse them. Fixed via a new `preservedAttachmentsRef`, populated by
   `editInstead()` before the ref gets cleared.
2. A "canceled" enrichment (Edit tapped, never resubmitted) still wrote its result to disk,
   because tapping Edit never touches the file, so the in-flight `enrichIdeaInPlace`'s mtime
   guard still matched. Fixed by having `editInstead()` perform a throwaway `rewriteRawIdea`
   of the same unedited draft, purely to bump the mtime and invalidate the in-flight call's
   guard — reusing the existing conflict mechanism rather than adding new cancellation plumbing.
3. Generalized re-enrich (`reEnrichNoteInPlace`) dropped attachments for Idea notes specifically
   — the identical bug fixed for Person in round 2, never checked against Idea's own branch
   of the same function. Fixed via a new `attachmentsFromBody()` helper that reuses the
   existing `listPairedBinaries()` (found in `writer.ts`, not reinvented) to re-derive
   attachment refs from the note's current markdown.

**Round 5 (adversarial re-review of round 4's fixes found 3 more, closing the pattern):**
1. HIGH — the round-4 mtime-bump fix was reachable from `reEnrichSaved()` (the "Finish
   enrichment" trigger on already-saved notes), whose `rawWriteRef` is a *synthetic*
   promise (no real write happens there). Edit tapped during a `reEnrichSaved()` call would
   fire the mtime-bump with the ORIGINAL raw pre-enrichment text, unconditionally overwriting
   an already-enriched or Syncthing-synced note with a stale raw stub — real data loss. Fixed
   with a `rawWriteIsRealRef` boolean, `true` only where `submit()` publishes a genuine write.
2. MEDIUM — the mtime-bump write didn't pin `created:`, so `buildRawIdeaMarkdown`'s default
   `now = new Date()` silently reset the note's original capture timestamp on every Edit tap.
   Fixed by threading an explicit `createdAt` through every `writeRawIdea`/`rewriteRawIdea`
   call in the flow, captured once on first write and reused on every resubmit/bump.
3. MEDIUM — the attachment merge (round 4, fix 1) had no de-dup, risking a doubled attachment
   embed when a still-staged attachment appeared in both `preservedAttachmentsRef` and a
   fresh `persistAttachments()` result. Fixed with a `Map` keyed by `rel` path.

**Verification method for round 5**: the final adversarial review pass used mutation testing
(temporarily reverting each of the 4 guards and confirming the corresponding regression test
fails) rather than only reading the code — all 4 mutants were killed by their intended test.
Recommendation was APPROVE with one LOW (a docblock comment overstating what's suppressed in
the `reEnrichSaved` path), fixed directly as a one-line comment update.

**Total findings across all rounds on this branch: 5 CRITICAL, 3 HIGH, 5 MEDIUM, 1 LOW** —
all fixed and independently re-verified (typecheck/lint/full test suite/capture-flow gate
re-run fresh after every round, not taken on the executor's or reviewer's word).

## Next Steps
- [ ] Manual on-device validation (Pixel, ADB-connected per project memory) — the plan's
      manual validation checklist (Edit during submitting for all 3 modes, re-enrich a
      normally-enriched Idea note, verify pending-enrich notes still show "Finish
      enrichment") has not been exercised on-device in this session
- [x] Create PR — #142, https://github.com/Entrevoix/carnet/pull/142
- [ ] If Journal re-enrichment is wanted later, it needs to be entry-scoped (operate on
      one `## HH:MM` section, not the whole day file) — a separate plan, not a resumption
      of this one
