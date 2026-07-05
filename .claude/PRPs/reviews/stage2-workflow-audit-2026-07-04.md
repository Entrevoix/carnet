# Stage 2 Execution-Workflow Audit — Parallel Background Subagent Orchestration

**Date:** 2026-07-04
**Scope:** Process audit of how B0/B1/B3/B4 were dispatched, run, and reconciled. Not a code audit.
**Auditor:** architect (read-only)
**Evidence base:** Session ground-truth (Incidents 1–3) + git graph verification.

---

## 0. Verified facts (git state at audit time)

- Local feature branches present: `feat/b0-net-hardening`, `feat/b1-model-split`, `feat/b3-sanitize-normalize`, `feat/b4-capture-timing`; each carries exactly one feature commit.
- Commit graph confirms the collision setup in **Incident 2**: B1 (`5a30fc9`) and B4 (`61312a5`) both branch from the **same** `main` commit `ddcfef5`. Two concurrent code-writing agents rooted at the identical checkout is exactly the precondition for working-tree cross-contamination.
- B3 (`8ca48c0`) and B0 (`4e2ad7d`) branch from earlier `main` states — they ran at different times and did not collide, consistent with the account.

The git history itself is clean on every branch. **Every incident was a working-tree / process-state failure, never a committed-history failure.** That is the single most important diagnostic fact in this audit and it drives most recommendations below.

---

## Summary

The orchestration pattern is sound in its fundamentals (self-contained prompts, commit-not-push, green-gate on tsc+vitest) and it *recovered* from all three incidents. But it recovered by luck and redundant vigilance, not by design. All three incidents share one root cause class: **the pattern treats the shared working directory and the orchestrator's own branch position as ambient global state, while running multiple agents that mutate that state concurrently.** Git's committed history was never at risk; the working tree and `HEAD` pointer were. The fixes are cheap and structural: mandate worktree isolation for concurrent committers, make each subagent's final act a branch-confirmed fresh re-verify, template the prompt, and set a trust policy keyed on whether the report can be independently reproduced.

---

## 1. Root-cause analysis of the three incidents

### Incident 1 — Docs commit on the wrong branch

**Mechanism:** The orchestrator's current branch is *global mutable state* that survives across task boundaries. After B0 finished, `HEAD` was left on `feat/b0-net-hardening`. The handoff-doc write+commit assumed "I am on main" without asserting it. `git commit` faithfully committed to wherever `HEAD` pointed.

**One-off or structural?** **Structural.** This is not carelessness — it is the default failure mode of any workflow where (a) branch position is implicit, (b) the orchestrator switches branches to service subagents, and (c) commits happen without a pre-commit branch assertion. It will recur every time the orchestrator commits anything (docs, fixups) after having checked out a feature branch. The cherry-pick + `reset --hard` + `push --force-with-lease` cleanup was disproportionate effort for a one-line guard.

**Structural gap:** No invariant "assert expected branch before any write/commit."

### Incident 2 — Concurrent subagents sharing one working directory

**Mechanism:** Two background code-writing agents (B1, B4) were launched against the same physical checkout with no `isolation: 'worktree'`. A working tree is a single global mutable resource; two writers is a data race. The specific manifestation: `git checkout feat/b1-model-split` while B4 had an uncommitted `writer.ts` edit — git carries uncommitted changes across a checkout when there's no path conflict, so B4's half-finished diff silently rode onto B1's branch. The committed histories were never entangled (that is why B1 pushed safely on its own commits), but the *working tree* was in a hybrid B1+B4 state.

**One-off or structural?** **Structural, and the most dangerous of the three.** It resolved only because *two independent parties* (the orchestrator and the B4 subagent) each separately noticed the anomaly and self-corrected. That is redundant luck, not a control. Change any one variable — B4 commits a fraction of a second earlier, or the two edits touch the same file with a conflict, or B4's stash/pop races the orchestrator's checkout — and you get lost work or a corrupted commit. Relying on two agents to each independently detect and hand-repair a race is not a safety property; it is an unhandled concurrency bug that happened to no-op.

**Structural gap:** No isolation between concurrent committers. Shared working tree + shared `HEAD` are treated as if single-threaded.

### Incident 3 — Stale/transient type diagnostics causing a false alarm

**Mechanism:** Two distinct sub-mechanisms, both downstream of Incident 2:
1. *Mid-flight diagnostics* (during B1's rename) — the IDE type-checker reads the working tree continuously, so it surfaced errors from a subagent's half-applied edit. Correctly ignored.
2. *Post-contamination phantom* (`omniroute.ts:377: Property 'omniRouteVisionModel' does not exist`) — this was a real-looking error produced by the **hybrid B1+B4 working-tree state** created during the Incident 2 checkout dance, not by B4's actual committed code. The orchestrator could only clear it by manually re-checking file content and re-running `tsc`/`vitest` against the correctly-checked-out branch.

**One-off or structural?** **Structural, and it is a direct consequence of Incident 2.** Fix the working-tree sharing and mechanism (2) largely disappears — a phantom error caused by cross-branch contamination cannot occur if branches never share a working tree. Mechanism (1) is inherent to any live type-checker watching an in-progress edit; the fix is not to trust ambient/live diagnostics as a completion signal at all, only fresh command-line `tsc` runs against a known-clean checkout.

**Structural gap:** The workflow used *ambient IDE diagnostics* as a truth signal. Ambient diagnostics reflect whatever transient state the working tree is in, which under concurrency is meaningless. Truth must come from a reproducible command against a known branch state.

**Cross-cutting root cause:** All three are the same bug wearing three hats — *global mutable process state (working tree + HEAD) shared across concurrent actors, with truth signals read from that shared mutable state instead of from isolated, reproducible checks.*

---

## 2. Fix for the worktree-sharing problem (Incident 2)

**Recommendation: MANDATORY `isolation: 'worktree'` for any subagent that both (a) may run concurrently with another code-writing subagent AND (b) will `git commit`. This is not "it depends" — for that intersection it is a hard rule.**

Rationale:

- The cost of a worktree is trivial relative to what it prevents. Worktree setup is a `git worktree add` (seconds, shares the object store, no re-clone). The failure it prevents is silent cross-branch code contamination and phantom diagnostics that cost a manual cherry-pick, a `reset --hard`, a force-push, and two separate agents' worth of detect-and-repair effort. The asymmetry is enormous.
- "Lightweight branch" is *not* a valid exception when concurrency is present. B1 (a model-field split) and B4 (a capture-timing guard) were both individually lightweight, and lightweight is exactly what lulled the workflow into skipping isolation. Weight of the change is irrelevant; **concurrency of committers** is the only variable that matters.
- The pattern already commits-not-pushes, so each worktree ends with a local commit on its own branch. Merging back is just `git fetch`/branch visibility from the shared object store — no extra reconciliation cost.

**Precise policy (decision table):**

| Subagent runs... | Will `git commit`? | Isolation |
|---|---|---|
| Concurrently with another code-writer | Yes | **Worktree — MANDATORY** |
| Concurrently with another code-writer | No (read-only/analysis) | Shared OK (read-only can't corrupt tree) |
| Strictly serially (no other writer active) | Yes | Shared OK, **but** must assert branch before every commit (see §1 Incident 1 fix) |
| Any | Any, and cheap to isolate anyway | Prefer worktree by default |

**Default recommendation beyond the hard rule:** make worktree the *default* for every code-writing subagent, concurrent or not. The serial-safe exception exists but relies on the orchestrator perfectly tracking "is another writer active?" — which is itself fragile ambient state. Defaulting to worktree removes that judgment call. The only agents that should share the main checkout are read-only ones.

**What this would have changed in Incident 2:** B1 and B4 in separate worktrees → the orchestrator's `git checkout feat/b1-model-split` happens in B1's worktree and cannot pick up B4's `writer.ts` edit (different working directory). No hybrid state, no phantom `omniroute.ts:377` error (Incident 3 mechanism 2 never fires), no cherry-pick cleanup risk.

---

## 3. Subagent self-verification checklist (before claiming "done")

The proposed final sequence — **checkout own branch → confirm `git branch --show-current` matches expected → re-run tsc+vitest fresh → then report** — is **necessary but not sufficient.** It closes Incident 3's mechanism (1) (no more trusting mid-flight/ambient diagnostics) but must be hardened against the specific ways Incident 2 corrupted state. Full checklist:

**Definition-of-Done gate — every code-writing subagent runs this as its literal final actions, in order:**

1. **Assert identity:** `git branch --show-current` equals the exact expected branch name (passed in the prompt). If not, STOP and report anomaly — do not commit, do not "fix."
2. **Assert clean-and-committed:** `git status --porcelain` is empty. A non-empty tree at report time means either unfinished work or foreign contamination — either way, do not report done. (This is the check that would have flagged the hybrid state directly.)
3. **Assert the commit is yours and complete:** `git log -1 --stat` shows your commit touching the files you intended and no foreign files (e.g., a stray `writer.ts` when you're B1). Cross-check the changed-file list against the prompt's declared file scope.
4. **Fresh verification from a cold command line, not the IDE:** run `tsc --noEmit` and `vitest run` as fresh processes and paste the actual tail of output (test counts, exit code) into the report. Never report a type/test result sourced from live IDE diagnostics.
5. **Scope assertion:** confirm the diff touches only files inside the declared scope; flag any out-of-scope file for the orchestrator.
6. **Report contract:** the final message must include: expected-branch name, `git branch --show-current` output, commit SHA, changed-file list, and the raw tail of the tsc + vitest runs (with counts). A report lacking any of these is treated as unverified.

**Is "checkout own branch + confirm + re-run + report" sufficient?** No — it omits step 2/3 (the porcelain + foreign-file checks). Incident 2's corruption was an *extra uncommitted file appearing*, not the agent being on the wrong branch. An agent that only checks its branch name and re-runs tests could still be sitting on a dirty tree containing another agent's edit and report green. The clean-tree and no-foreign-files assertions are the ones that specifically catch Incident 2. With worktree isolation (§2) these become cheap belt-and-suspenders; without it, they are the only line of defense.

---

## 4. Reusable executor-prompt template

Drop-in template for B2 (when unblocked), B5, B6, B7 and beyond. Fill the `{{...}}` slots; leave the fixed sections verbatim so the gaps from this session cannot recur.

```markdown
# Executor Task: {{BRANCH_ID}} — {{one-line title}}

## 0. Isolation & Branch (FIXED — do not modify)
- Base branch: main
- Your branch (create from main): {{feat/bN-slug}}
- Isolation: WORKTREE REQUIRED if any other code-writing agent may run
  concurrently with you. If in doubt, use a worktree.
- Do NOT push. Commit locally only. Do NOT touch any branch other than yours.
- Before EVERY commit: run `git branch --show-current` and confirm it equals
  {{feat/bN-slug}}. If it does not, STOP and report — do not commit or "fix."

## 1. Design Spec
{{What to build, the behavior/contract, and the acceptance criteria.
Link the source design doc section. Be specific about the intended end-state.}}

## 2. Investigation (read before writing)
Files to read first:
{{explicit file list}}
Questions to answer before editing:
{{e.g. "where is X defined", "what calls Y", "existing test coverage of Z"}}

## 3. Scope Boundary (FIXED format)
Files you are ALLOWED to modify:
{{explicit allowlist}}
Anything outside this list: do NOT edit. If the task seems to require it,
STOP and report — the scope may be wrong.

## 4. Required Tests
{{Named tests / suites that must exist and pass. New tests to add.}}
Green-gate: `tsc --noEmit` clean AND `vitest run` fully green.

## 5. Constraints (FIXED)
- Immutable patterns; no mutation of shared state.
- No new dependencies without flagging.
- No debug/console statements left in.
- Keep files within repo norms (<800 lines).

## 6. Definition of Done (FIXED — run these as your literal final actions)
1. `git branch --show-current` == {{feat/bN-slug}}   (else STOP + report)
2. `git status --porcelain` is empty                  (else STOP + report)
3. `git log -1 --stat` shows only your intended files, no foreign files
4. Fresh `tsc --noEmit` — paste exit code + tail
5. Fresh `vitest run` — paste pass/total counts + exit code
6. Diff touches only the §3 allowlist
7. Report back with: expected branch, `git branch --show-current` output,
   commit SHA, changed-file list, raw tsc tail, raw vitest counts.
   A report missing any of these is incomplete.
```

The value: sections 0, 3, 5, 6 are *fixed and identical* across every branch (that is what was missing — each prompt restated a similar-but-not-identical DoD). Only 1–4 are authored per branch. This eliminates the "similar-but-not-identical list" drift and bakes in the Incident 1/2/3 guards.

---

## 5. Policy on orchestrator trust of subagent self-reports

**Rule (concrete, not "use judgment"):**

> The orchestrator independently re-verifies **at the moment it takes a state-changing action on that branch** (checkout-to-push, merge, tag) — always, unconditionally — by running `tsc`/`vitest` fresh against the checked-out branch. Between report and that action, the report is provisionally trusted for *planning* but never for *irreversible action*.

Concretely:

- **Trust the report for:** deciding what to do next, sequencing, reading status. Cheap, reversible.
- **Never trust the report for:** the push/merge itself. Before pushing branch N, the orchestrator checks out N in a clean state (ideally its worktree), confirms `git status --porcelain` empty, and re-runs the green-gate fresh. This is one command sequence and it is the difference between B1's push (trusted directly) and B4's push (re-verified after a scare) — the inconsistency was the actual problem, not either choice individually.
- **Escalate to full manual audit when** any of these signals fire: non-empty working tree at report time, a foreign file in the diff, any diagnostic mentioning a symbol owned by *another* concurrent branch (the Incident 3 tell), or the report omits any Definition-of-Done field.

**Why unconditional re-verify at the push boundary rather than "only when signals suggest something's off":** Incident 3 is proof that the signal (a plausible-looking type error) was *misleading in both directions* — it looked real but wasn't, and it took manual re-verification to know which. If you only re-verify when a signal fires, you both (a) chase false alarms and (b) can miss silent corruption that throws no signal. Anchoring re-verification to the *irreversible action* (push/merge) rather than to *signals* makes the policy deterministic: the cost is bounded (one gate run per push), and it is exactly where a mistake becomes expensive. B1 was pushed on trust and happened to be fine; make that not a gamble.

---

## 6. Other process gaps observed

1. **No single source of truth for "which agents are live."** The orchestrator's decision to `git checkout` mid-run (Incident 2 step 2) was made without knowing B4 had an in-flight edit. Even with worktrees, a lightweight live-agent registry (branch → status → worktree path, e.g. in `.omc/state/` or a scratch file) would let the orchestrator avoid touching a branch/tree another agent is actively writing.

2. **Handoff-doc commits share the code-commit surface.** Incident 1 was a *docs* commit landing on a *code* branch. Docs/handoff commits should have a dedicated, explicit target (e.g. always `main` or a `docs/*` branch) and their own assert-branch guard, rather than inheriting whatever `HEAD` the last subagent left behind.

3. **Ambient IDE diagnostics were treated as a signal at all.** The whole of Incident 3 stems from reading a live, continuously-recomputed view of a shared mutable tree. Policy should be explicit: *IDE/live diagnostics are never a completion or failure signal; only fresh CLI `tsc`/`vitest` against a known checkout are.* This belongs in the orchestrator's operating rules, not just the subagent DoD.

4. **Dependency-order-on-paper vs. launch-order-in-practice drift.** Branches are documented B3→B0→B1→B2→B4→B5→B6→B7 but launched with ad-hoc parallelism (B1 ∥ B4). That is fine *when* branches are truly independent, but the independence is asserted informally. Recommend an explicit per-branch declaration in the prompt: "concurrency-safe with: {list}" / "must run after: {list}", so the parallelism decision is recorded, not improvised — and so the §2 worktree mandate can be applied automatically whenever two concurrency-safe branches are launched together.

5. **Recovery playbooks are re-derived each time.** The Incident 1 cleanup (cherry-pick → reset → force-with-lease) and the Incident 2 stash/checkout/pop dance were both improvised. Given the pattern will keep producing these situations until the structural fixes land, a short `.claude/` runbook ("commit landed on wrong branch", "foreign edit in working tree") would cut recovery time and reduce the chance of a mistaken `reset --hard` losing real work.

6. **No post-run tree-cleanliness assertion by the orchestrator between branches.** A stray `M writer.ts` was noticed *reactively*. A cheap `git status --porcelain` check by the orchestrator before and after each branch operation would surface contamination proactively.

---

## Root Cause (single statement)

The orchestration pattern shares two pieces of global mutable process state — the working directory and the `HEAD`/current-branch pointer — across concurrent, committing actors, and reads its truth signals (branch position, type/test health) from that shared mutable state instead of from isolated, reproducible checks. Every incident is a surface of that one design gap. Committed git history was never at risk, which is precisely why the recoveries were possible — and why the fixes (worktree isolation + branch-asserted fresh re-verification) are cheap.

## Recommendations (prioritized)

1. **Mandate worktree isolation for concurrent committers (§2)** — low effort, highest impact. Eliminates Incidents 2 and most of 3 by construction.
2. **Adopt the fixed Definition-of-Done gate in every executor prompt (§3, §4 section 6)** — low effort, high impact. Catches Incidents 1 and 2 at the subagent boundary.
3. **Set the push-boundary unconditional re-verify policy (§5)** — low effort, high impact. Removes the trust inconsistency that made B4 a scare.
4. **Adopt the reusable prompt template (§4)** — medium effort once, compounding payoff for B5–B7.
5. **Add live-agent registry + orchestrator tree-cleanliness checks + recovery runbook (§6.1, §6.5, §6.6)** — medium effort, defense-in-depth.

## Trade-offs

| Option | Pros | Cons |
|---|---|---|
| Mandatory worktree for concurrent committers | Removes the race by construction; cheap object-store-shared setup | Slightly more setup per launch; orchestrator must track worktree paths |
| Worktree as default for ALL code-writers | No judgment call about "is another writer live"; simplest rule | Marginal overhead on truly-serial single-branch runs |
| Unconditional re-verify at push boundary | Deterministic, bounded cost, catches silent corruption | One extra gate run per push (seconds); redundant when reports are honest |
| Re-verify only on signals | Cheaper when all-clean | Incident 3 proves signals mislead; can miss signal-less corruption |
| Fixed prompt template | Kills DoD drift; bakes in guards | Small upfront authoring; must be kept in sync as norms evolve |

## References

- `.claude/PRPs/reviews/stage2-workflow-audit-2026-07-04.md` — this report.
- git graph: B1 `5a30fc9` and B4 `61312a5` both branch from `main` @ `ddcfef5` — verified precondition for Incident 2.
- Local branches `feat/b0-net-hardening`, `feat/b1-model-split`, `feat/b3-sanitize-normalize`, `feat/b4-capture-timing` — one clean feature commit each; all incidents were working-tree/HEAD state, not committed history.
