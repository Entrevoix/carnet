# Decision memo — capture timing: blocking enrich-preview vs save-first for text captures

**Status:** recommended, pending user sign-off · **Date:** 2026-07-04 · **Feeds:** `stage2-backend-and-capture.plan.md` (branches B4/B5) · **Source:** AUDIT.md §2.3–2.4, Open Question 5

## The question

Idea/Journal/Person captures currently **block on the LLM** between Send and a preview, and the note only exists after an explicit Save tap (`CaptureScreen.tsx:271-362` enrich→preview, `:364-443` write). Photo/share save-first with a stub + degraded banner; audio saves instantly and transcribes async. Should Idea and Journal move to the save-first model — which is what unlocks notification inline reply (zero-app-open capture) and removes seconds of blocking from the two modes most sensitive to capture speed?

## Facts that bound the decision (all verified in-repo)

- **Every mechanism save-first needs already exists and is proven.** Offline queue with raw-payload drain (`lib/queue.ts`), stub + `degradedReason` banner + in-place re-enrich (`PhotoCaptureScreen.tsx:150-248`), and **retro-enrich on RecentDetail** (shipped — `.claude/PRPs/reports/recents-retro-enrich-report.md`). This is a UX-policy change, not new architecture.
- **The preview's protective value is lowest exactly where its cost is highest.** Idea/Journal synthesis errors are cheap to fix (local vault, inline edit shipped, retro-enrich shipped). Person errors are costly (wrong email/phone from fallible OCR) and the review step earns its tap.
- **The Syncthing wrinkle.** A raw note written immediately can sync to the workstation before the enriched rewrite lands. Consequences: (a) Obsidian may briefly show the raw note — cosmetic; (b) a workstation edit inside that window collides with the enriched overwrite — same class as the known promote-idea mtime race (`TODO.md:33`), and the same mitigation applies (compare mtime before overwrite; on conflict, keep the user's version and drop a banner instead of clobbering).
- **Journal is append-structured.** Async enrichment must rewrite only the block it created (`## HH:MM` + separator conventions, `writer.ts appendJournal`), not the whole file — the block boundaries make that tractable.

## Recommendation

**Flip Idea and Journal to save-first/async-enrich as the default. Keep Person on enrich-then-preview. Leave photo/share/audio as they are.**

Mechanics:

1. On Save (formerly Send), write the note immediately with deterministic client-side content: user text as body, client-generated frontmatter (`created`, user tags, location), plus `status: pending-enrich` (Idea) or an equivalent block marker (Journal append).
2. Fire enrichment async. On success, overwrite the note (or the journal block) with the enriched version, preserving client-injected frontmatter — guarded by the mtime check above. On transient failure, fall into the existing queue; on permanent failure, keep the raw note and show the degraded banner + re-enrich affordance (identical posture to photo).
3. Settings toggle `previewBeforeSave` (default **off**) restores the old flow for users who want to vet synthesis pre-save. Person ignores the toggle and always previews.

Why flip the default rather than opt-in: the product thesis (AUDIT.md Task 2 goal) is *fewest possible clicks to get data in*. A raw-but-saved note beats a polished note that was never captured because the phone was on the wrong network — and the failure modes are all recoverable in-app today.

## What this unlocks / what it costs

- **Unlocks:** notification inline reply (RemoteInput — zero-app-open idea capture, Stage 2 B5); one fewer tap on every Idea/Journal capture; no LLM wait on the critical path; captures work identically off-network (raw note now, enrichment on drain) instead of silently queueing into a different code path.
- **Costs:** raw notes transiently visible in the vault; a narrow overwrite-conflict window (mitigated, see above); users lose the default pre-save vet for Idea/Journal (recoverable via toggle, edit, or re-enrich).

## Rejected alternatives

- **Opt-in quick-save (keep blocking default):** preserves status quo comfort but leaves the flagship modes slow by default and makes inline reply a second-class path gated on a buried setting.
- **Save-first for Person too:** rejected — OCR'd contact data is the one place synthesis review demonstrably pays for its tap.
- **Draft/staging area outside the vault until enriched:** avoids the Syncthing wrinkle but adds a second persistence layer, breaks "the vault is the source of truth," and delays sync of the raw capture — worse than the problem it solves.
