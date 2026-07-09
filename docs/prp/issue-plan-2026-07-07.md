# Carnet — Issue Decomposition Plan (2026-07-07)

**Status: CREATED on GitHub 2026-07-07.**
Mapping: E1=#75 · E2=#76 · E3=#77 · S1.1=#78 · S3.1=#79 · T1–T13=#80–#92 in plan order.
#70/#73 labeled.
Repo: `Entrevoix/carnet` · CI green · 2 open issues (#73 Hermes crash — fix in flight on
`fix/hermes-worklets-sharedarraybuffer`; #70 SSRF normalization gaps) — both kept as
canonical, not duplicated.

## Sources consulted

- `README.md`, `CLAUDE.md` (hard constraints: **no SQLite** on Expo SDK 54, no `.env`,
  frontmatter byte-compat, no lint gate by design, squash-merge)
- `TODO.md` (v0.3 deferred scope — the repo's own backlog; only items with near-term
  action are promoted to issues, the rest stay in TODO.md)
- `docs/session-handoffs/2026-07-04-stage2-b3-b0.md` — Stage-2 B-sequence status + the 7
  resolved open questions. Shipped since: B0 (#64), B3 (#63), B4 (#66), B5 (#71/#74),
  B6 Phase 1 (#67), B7 Phase 1 dispatcher seam (#72), SSRF fix (#69). **Remaining: B1,
  B2 (user-gated), B7 Phase 2.**
- `.agent_native/agent_roadmap.md` (2026-07-07) — top-5 agent-native gaps
- `.claude/PRPs/` (master plan `stage2-backend-and-capture.plan.md`, PRDs incl.
  `on-device-backend.prd.md`) — issues reference these, never contradict them
- TODO/FIXME grep: only pointers back to TODO.md items (no hidden work)

## Proposed hierarchy

| Tier | Count | Items |
|---|---|---|
| Epic | 3 | E1 Stage-2 completion (B-sequence remainder) · E2 security hardening · E3 agent-native infrastructure |
| Story | 2 | S1.1 on-device backend Phase 2 (B7) · S3.1 screen-logic extraction |
| Task | 13 | T1–T13 |

Labels to create: `epic`, `story`, `task`, `area:capture`, `area:llm`, `area:security`,
`area:testing`, `size:S`, `size:M`.

---

## EPIC E1 — Stage 2 completion: the remaining B-sequence

**Labels:** `epic`, `area:llm`, `enhancement`

The Stage-2 master plan (`.claude/PRPs/plans/stage2-backend-and-capture.plan.md`, B0–B7)
is nearly done — B0/B3/B4/B5/B6-P1/B7-P1 all shipped since 2026-07-04. This epic tracks
what's left: B1 (model split), B2 (OCR endpoint, still gated on a user-run quality test),
and B7 Phase 2 (the actual on-device model behind the Phase-1 dispatcher seam).

### TASK T1 — B1: split chatModel/visionModel (repurpose the transcription setting)

## Summary
Split the single OmniRoute model setting into `chatModel` and `visionModel`, repurposing the vestigial `omniRouteTranscriptionModel` setting as `omniRouteVisionModel`, so text enrichment and vision captures (photo/person OCR) can use different models.

## Why (context a newcomer wouldn't have)
- OmniRoute is the self-hosted LLM router all four capture modes call. The handoff's open questions 3 and 6 are already resolved: "confirmed client-side split — proceed as planned in B1" and "repurpose rather than delete." B1 was "next up" in the sequence and is the only unshipped unblocked B-item; B7 Phase 1's dispatcher (PR #72) was built expecting it.
- Parent: E1. Spec: the Stage-2 master plan's B1 section.

## Scope (what to touch)
- `apps/mobile/src/lib/omniroute.ts` (~710 lines — resist enlarging it; extract if adding logic), `lib/storage.ts` settings keys + migration, `SettingsScreen.tsx` fields.
- Out of scope: `/ocr` dedicated endpoint work (B2, gated), on-device backend (B7).

## Acceptance Criteria
- [ ] Photo/person captures call the configured vision model and idea/journal enrichment calls the chat model, with the old `omniRouteTranscriptionModel` value migrated (not lost) — proven by vitest tests on the settings migration and request routing.

## Implementation notes
- Repo gates are `tsc --noEmit` + vitest only; ~600 co-located `lib/*.test.ts` tests are the pattern to follow. Settings keys persist in AsyncStorage (never SQLite); API keys stay in `expo-secure-store`.

## Size
M

## Depends on
none

## Labels
task, area:llm, size:M, enhancement

### TASK T2 — B2 gate: run the VLM-vs-dedicated-endpoint OCR comparison (user, on device)

## Summary
Run the side-by-side business-card OCR quality comparison (current VLM path vs OmniRoute's dedicated `/ocr` endpoint) on real cards on a real device, and record a go/no-go for B2.

## Why
- B2 has been explicitly deferred since 2026-07-04 with "do not start until the user runs the on-device comparison" (handoff, resolved-question 4). This is the blocking decision, owned by JD — it cannot be delegated to an agent (device + real business cards).
- Parent: E1.

## Scope
- No code. Results recorded in a short note under `docs/session-handoffs/` or the B2 section of the master plan.

## Acceptance Criteria
- [ ] A dated note records the comparison outcome and an explicit B2 GO / NO-GO.

## Size
S

## Depends on
none — blocks T3

## Labels
task, area:capture, size:S

### TASK T3 — B2: dedicated OCR endpoint integration (only if T2 says go)

## Summary
Route person-card OCR through OmniRoute's dedicated `/ocr` endpoint per the master plan's B2 section, replacing or augmenting the VLM path.

## Why
- Filed now so the sequence is visible; **do not start** until T2 records GO — the whole point of the gate is avoiding building against an endpoint whose quality is unproven. Parent: E1.

## Scope
- `lib/omniroute.ts` / `lib/ocr.ts` + tests. Per the master plan's B2 section.

## Acceptance Criteria
- [ ] Person capture uses the decided OCR path with a vitest test on the request/response mapping, and the master plan's B2 row is marked shipped.

## Size
M

## Depends on
T2 (GO verdict), T1 (model-setting split)

## Labels
task, area:capture, size:M, enhancement

### STORY S1.1 — B7 Phase 2: on-device LLM backend (true offline capture)

**Labels:** `story`, `area:llm` · Parent: E1

Phase 1 (PR #72) landed the pluggable dispatcher seam (`backend: "omniroute" | "local-device"`).
Phase 2 makes the local backend real: a Gemma-class model running on-device (MediaPipe LLM
Inference or ExecuTorch), so capture enrichment works in airplane mode. Spec:
`.claude/PRPs/prds/on-device-backend.prd.md`; trade-offs already accepted in TODO.md
(~1.5 GB model, ~3–8 s first token, battery cost). Cost pressure was "moderate — revisit
after B4/B5 ship"; B4/B5 have shipped.

#### TASK T4 — Local backend module implementing the dispatcher interface

## Summary
Implement `lib/localLlm.ts` (name per TODO.md's sketch): an on-device inference backend satisfying the same interface as `omniroute.ts` behind the Phase-1 dispatcher, for text-mode enrichment first (vision explicitly out of scope).

## Why
- The seam exists (PR #72) but has only one real backend. This is the core of B7 Phase 2. Parent: S1.1 → E1. Spec: `on-device-backend.prd.md`.

## Scope
- New `apps/mobile/src/lib/localLlm.ts` + native module wiring (MediaPipe LLM Inference vs ExecuTorch — the PRD's call; if the PRD leaves it open, that decision is part of this task and must be recorded in the PRD).
- Out of scope: model download UX (T5), settings switch (T6), vision on-device.

## Acceptance Criteria
- [ ] With a model file present on device, an Idea capture is enriched end-to-end with zero network calls, and the module's non-native logic (prompt assembly, response parsing, error mapping) has co-located vitest coverage using the existing `test/__stubs__/` pattern for native deps.

## Implementation notes
- AGPL-3.0 repo: verify the inference runtime's license compatibility before adding the dependency (MediaPipe is Apache-2.0 — fine; flag anything else).
- `mobile-android` CI is advisory-only — native-plugin changes need an explicit local `gradlew :app:compileDebugKotlin` check (CLAUDE.md).

## Size
M (the PRD may split it further — if it does, follow the PRD)

## Depends on
T1

## Labels
task, area:llm, size:M, enhancement

#### TASK T5 — Model provisioning: download, integrity, storage management

## Summary
Add the model-file lifecycle: user-triggered download (~1.5 GB) with progress, checksum verification, resume/cancel, and a way to delete the model to reclaim space.

## Why
- A 1.5 GB artifact can't ship in the APK; unmanaged downloads on mobile fail constantly. Without integrity checking, a truncated download produces confusing native crashes instead of a clear error. Parent: S1.1 → E1.

## Scope
- New `lib/` module + Settings UI section. Out of scope: inference itself (T4).

## Acceptance Criteria
- [ ] A fresh install can download the model with visible progress, an interrupted download is detected (bad checksum → clear re-download prompt, never a crash), and deleting the model frees the space and cleanly disables the local backend.

## Size
M

## Depends on
T4 (model format/runtime choice decides what's downloaded)

## Labels
task, area:llm, size:M, enhancement

#### TASK T6 — Backend switch UX + offline capture end-to-end

## Summary
Surface the `backend` setting (OmniRoute / On-device) in Settings with honest state (model not downloaded → switch disabled with explanation), and verify the full offline capture flow on device.

## Why
- The dispatcher decides per the setting; the setting needs guardrails so users can't select a backend that can't run. This task also carries the story's device-level acceptance run (airplane-mode capture). Parent: S1.1 → E1.

## Acceptance Criteria
- [ ] In airplane mode with the model installed, Idea and Journal captures complete and write correct Markdown (frontmatter byte-compatible — run the existing frontmatter tests), and with no model installed the switch clearly explains why it's disabled.

## Size
S

## Depends on
T4, T5

## Labels
task, area:llm, area:capture, size:S, enhancement

---

## EPIC E2 — Security hardening

**Labels:** `epic`, `area:security`

Follow-ups from the Stage-2 security reviews plus the one TODO.md item with a stated
deadline-like condition ("before any non-developer dogfooding").

*Existing #70 (SSRF host-parsing: percent-encoding + IDNA/fullwidth digits) stays the
canonical issue for the `extractHost` gaps — labeled, not duplicated.*

### TASK T7 — Encrypt offline queue payloads at rest

## Summary
Encrypt `payload_json` in the offline capture queue — it currently holds raw idea text, voice transcripts, and OCR'd business-card PII (names/emails/phones) in plaintext on-device storage.

## Why (context a newcomer wouldn't have)
- TODO.md classifies this as defense-in-depth for the single-developer threat model **but a blocker before any non-developer dogfooding**. Realistic threat: rooted/debug device, adb pull, or a privileged malicious app.
- **Constraint drift warning:** TODO.md's suggested approaches mention expo-sqlite/SQLCipher, but the repo's hard constraint (CLAUDE.md, post-dating that TODO entry) is **no SQLite** — the queue now lives in AsyncStorage (`lib/queue.ts`). The valid approach is field-level encryption: AES-GCM via `expo-crypto` with the key in `expo-secure-store`. Do not resurrect SQLite for this.
- Parent: E2.

## Scope (what to touch)
- `apps/mobile/src/lib/queue.ts` (+ a small `lib/queueCrypto.ts`), migration for existing queued items.
- Out of scope: encrypting the written vault files (they're the user's plaintext Obsidian vault by design).

## Acceptance Criteria
- [ ] Queued payloads are unreadable in raw AsyncStorage dumps (vitest: enqueue → inspect storage stub → ciphertext; drain → plaintext restored), with existing queued plaintext items migrated or drained safely on upgrade.

## Size
M

## Depends on
none

## Labels
task, area:security, size:M

---

## EPIC E3 — Agent-native verification infrastructure

**Labels:** `epic`, `area:testing`

From `.agent_native/agent_roadmap.md` (2026-07-07), ranked by human-attention saved:
fixtures/replay harness, screen-logic extraction, smoke-test automation bridge, PRP
lifecycle checking. (Roadmap item 4 — documenting CI tribal knowledge — already landed
in CLAUDE.md.)

### TASK T8 — Fixture/replay harness for writer/omniroute bug reports (roadmap #1)

## Summary
Create `apps/mobile/test/fixtures/` (real-shaped vault notes + canned OmniRoute responses) and a `repro.test.ts` runner so frontmatter/markdown bugs reproduce in one command instead of via hand-derived repro steps.

## Why
- The roadmap's #1 finding: re-deriving repros is the top recurring cost in this repo's own session handoffs; no fixtures exist anywhere. Fixture set = the historical bug classes: unicode slugs, filename collision, same-day journal append, mtime conflict guard, malformed/oversized OmniRoute responses.
- Parent: E3.

## Acceptance Criteria
- [ ] `npm -w @carnet/mobile exec vitest run test/fixtures/repro.test.ts` reproduces at least the 4 named historical bug classes from fixtures, no device needed.

## Size
M

## Depends on
none

## Labels
task, area:testing, size:M, enhancement

### STORY S3.1 — Extract inline business logic from the three oversized screens (roadmap #2)

**Labels:** `story`, `area:testing` · Parent: E3

`CaptureScreen.tsx` (~1039 lines), `RecentDetailScreen.tsx` (~1458), `SettingsScreen.tsx`
(~934) mix untested business logic into JSX, violating the repo's own 800-line norm; 0 of
12 screens have tests. Target pattern already exists: `lib/ideaSaveFirst.ts`,
`lib/journalTagIndex.ts`. One task per screen — same shape, independently mergeable.

#### TASK T9 — Extract CaptureScreen logic into tested lib modules

## Summary
Move CaptureScreen's non-UI logic (save-flow orchestration, conflict-message handling, mode dispatch) into new `lib/*.ts` modules with co-located tests, dropping the screen under 800 lines.

## Acceptance Criteria
- [ ] `CaptureScreen.tsx` < 800 lines with behavior unchanged (existing tests green) and each extracted module has a co-located `.test.ts`.

## Implementation notes
- Behavior-preserving refactor only — no UX changes ride along. `tsc --noEmit` + full vitest suite are the gates. Parent: S3.1 → E3.

## Size
M · **Depends on:** none · **Labels:** task, area:testing, size:M

#### TASK T10 — Extract RecentDetailScreen logic into tested lib modules

## Summary
Same treatment for the largest screen (~1458 lines): extract Karakeep re-export confirm logic, promote/conflict handling, and detail-view state into tested `lib/` modules.

## Acceptance Criteria
- [ ] `RecentDetailScreen.tsx` < 800 lines, behavior unchanged, extracted modules tested.

## Size
M · **Depends on:** T9 (establishes the extraction conventions) · **Labels:** task, area:testing, size:M

#### TASK T11 — Extract SettingsScreen logic into tested lib modules

## Summary
Extract settings validation/persistence logic (~934-line screen) into tested `lib/` modules.

## Acceptance Criteria
- [ ] `SettingsScreen.tsx` < 800 lines, behavior unchanged, extracted modules tested.

## Implementation notes
- Coordinate with T1 (B1 adds settings fields) — land T1 first or rebase over it. Parent: S3.1 → E3.

## Size
S · **Depends on:** T9, T1 · **Labels:** task, area:testing, size:S

### TASK T12 — `verify:capture-flow` script bridging docs/smoke-test.md (roadmap #3)

## Summary
Add an `apps/mobile/package.json` script that runs exactly the vitest suites covering the smoke-test checklist's automatable logic, and annotate `docs/smoke-test.md` sections with "automated coverage: `npm run verify:capture-flow`".

## Acceptance Criteria
- [ ] The script exists, exits 0, and every smoke-test section states either its automated-coverage command or "device-only".

## Size
S · **Depends on:** none · **Labels:** task, area:testing, size:S

### TASK T13 — Machine-checkable PRP plan lifecycle (roadmap #5)

## Summary
Add a required `Status: draft|in-progress|shipped` header to `.claude/PRPs/plans/*.md` and a small `scripts/check-stale-plans.sh` that flags shipped-but-not-moved plans.

## Why
- A previous backlog audit found three plans describing already-shipped work, costing a full human audit cycle. Parent: E3.

## Acceptance Criteria
- [ ] Running the check script lists zero violations on a clean tree and correctly flags a test case of a shipped-marked plan still in `plans/`.

## Size
S · **Depends on:** none · **Labels:** task, area:testing, size:S

---

## Existing issues — disposition

- **#73** (Hermes/worklets SharedArrayBuffer dev-build crash): fix in flight on
  `fix/hermes-worklets-sharedarraybuffer` — canonical, untouched. Suggest `bug`.
- **#70** (SSRF `extractHost` percent-encoding/IDNA gaps): canonical tracked follow-up
  from PR #69's review. Suggest `bug`, `area:security`; conceptually under E2.

## Deliberately NOT filed

- **v0.4 AI-deepening S1–S4**: has its own PRD (`v0.4-ai-deepening.prd.md`) and is an
  independent axis — decompose when it's actually scheduled.
- **B6 Phase 2 (browse/search)**: Phase 1 shipped (#67); Phase 2 scope isn't pinned in
  the docs I audited — needs the PRD re-read before decomposition, not a guessed issue.
- **TODO.md v0.3 polish items** (unicode slugifier, connection-test button, card
  auto-detect, cross-capture linking, multi-vault, desktop fate, Whisper consolidation):
  TODO.md is the right home for deferred-by-design scope; promoting them all would just
  fork the backlog. Promoted only where action is near-term (T7 queue encryption).
- **Person camera pipeline integration test** (TODO carry-over): folded conceptually into
  the smoke-test bridge (T12) + B2 gate (T2) rather than a standalone issue.

## Creation order

Labels → E1–E3 → S1.1, S3.1 → T1–T13 → checklists; label #70/#73.
