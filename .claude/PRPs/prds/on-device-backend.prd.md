# PRD: pluggable on-device LLM backend

**Status:** design, gated on the model-split branch · **Date:** 2026-07-04 · **Source:** `TODO.md:25` (on-device Gemma), AUDIT-backend.md §1.2/§1.4, backend-interface fact pass. **Hard prerequisite:** the per-task model split (`chatModel`/`visionModel`, Stage 2 branch B1) must land first — a text-only local backend must never silently receive image parts.

## Theme

A second enrichment backend that runs on-device, selectable alongside OmniRoute via a `Settings.llmBackend` field. Delivers true offline capture (airplane mode, privacy-sensitive contexts) with zero marginal API cost. The `omniroute.ts` interface was shaped for exactly this; this PRD defines the seam and the honest cost of filling it.

## The seam (verified)

Both the online capture path (`CaptureScreen.handleCaptureError`) and the offline drain path (`queue.drainQueue`) branch **only** on two predicates — `isPermanentError` and `isNotConfiguredError` (`omniroute.ts:110,118`) — never on concrete error types. So a sibling backend drops in if it:

1. Implements the consumed surface with identical signatures, returning `EnrichResult = {markdown, model}`:
   `enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage` (vision), `enrichSharedLink`, `promoteIdea`. (`transcribeAudio` is **already on-device** — no work; `listModels` is OmniRoute-specific — the local backend returns its bundled model id.)
2. Throws errors satisfying the two predicates — reuse `OmniRouteError` (rename to `EnrichError`) with `notConfigured: true` when the model file is missing/not downloaded, and a permanent/transient distinction so the queue's retry-vs-give-up classification (`queue.ts:222-262`) stays correct.
3. Honors `PromptOverrides` identically, so `prompts.ts` (`buildIdeaPrompt` → `PromptPair {system,user}`) is shared unchanged across backends.

**Implementation shape:** a `dispatcher.ts` that reads `Settings.llmBackend` and re-exports the six functions from the selected backend. `queue.ts` and the capture screens import from the dispatcher instead of `./omniroute` directly — the one structural refactor this needs.

## Settings

Add `llmBackend: "omniroute" | "on-device"` to `Settings` and `PersistedSettings` (non-secret → AsyncStorage), default `"omniroute"` in `DEFAULT_PERSISTED` (`settings.ts:91`). Backward-compat is automatic — `readPersisted` spreads `{...DEFAULT_PERSISTED, ...parsed}`, so old blobs take the default. Plus model-path/download-state fields as non-secret persisted settings.

## The honest cost (this is the hard part, not the seam)

The interface is easy; the native inference module and the model file are not. Verified precedent and gaps:

- **Native module pattern exists:** `withAudioDecoder.js` is a full custom Kotlin RN module wired by a two-stage config plugin (`withMainApplication` regex-injects `getPackages()` registration with a loud-throw-on-miss guard learned from PR #22; `withDangerousMod` writes the `.kt` files). An inference module (`@ReactMethod generate(prompt, opts, promise)`) follows the same pattern.
- **No precedent for a large binary.** `withAudioDecoder` ships code only. There is **no** existing handling for a multi-hundred-MB model asset, **no** `largeHeap` in the manifest, and **no** `abiFilters`/NDK/`.so` config anywhere (`app.json:20-36`). A real on-device LLM (llama.cpp / MediaPipe LLM Inference / ExecuTorch) introduces the *first* native `.so` and ABI concern in the project, and almost certainly needs `largeHeap`.
- **Model delivery** must be download-on-demand (a ~1.5 GB APK asset is a non-starter): first-run fetch to app storage, integrity check, `notConfigured` until present. This is net-new infrastructure.
- **SQLite is unavailable** (`queue.ts:16-18` — expo-sqlite@55 SharedRef ABI error on SDK 54) — irrelevant to inference but rules out any SQLite-backed model/embedding cache until the SDK upgrade.
- **Vision gap:** most on-device small models are text-only. `enrichSharedImage` on the local backend should throw `notConfigured`/permanent so the caller falls to its existing stub+banner, OR the dispatcher routes vision to OmniRoute even when text is local (recommended — see open decisions). This is why B1 (model split) is a hard prerequisite.

## Non-goals

- Workstation Ollama variant — explicitly rejected (`TODO.md:25`): re-introduces the daemon/reachability dependency v0.2 removed.
- On-device vision/OCR — text enrichment only in v1; vision stays on OmniRoute.
- Replacing OmniRoute — this is an *alternative* backend, default stays OmniRoute.

## Phasing

1. **Interface refactor (shippable alone, no native code):** extract `dispatcher.ts`, point `queue.ts` + capture screens at it, add the `llmBackend` setting (only `"omniroute"` wired). Pure structural prep; de-risks everything after. Depends on B1.
2. **Native inference module:** the `withInference` config plugin + Kotlin module against a chosen runtime. The real spike — validate first-token latency and memory on the Pixel test devices before committing.
3. **Model download/lifecycle + Settings UI:** on-demand fetch, integrity, backend picker, per-backend model config.
4. **Wire the local backend** into the dispatcher; vision routing decision (below).

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| First-token latency 3-8 s on phone (per TODO) degrades capture feel | High | Pair with the save-first capture-timing decision — local enrichment async on an already-saved note removes it from the critical path |
| Native `.so`/ABI/largeHeap is new ground; build-size + memory blowups | High | Phase 2 spike gates the rest; abiFilters to arm64-v8a only |
| Model download UX (1.5 GB on cellular) | Medium | Wi-Fi-only default, explicit user opt-in, resumable |
| Local text model can't do vision → silent degradation | Medium | B1 prerequisite + dispatcher routes vision to OmniRoute regardless of text backend |
| Output quality below `gpt-4o-mini`, frontmatter non-compliance | Medium | The frontmatter normalizer (Stage 2 B3) makes non-compliance fail loud instead of corrupting notes |

## Open decisions

- **Hybrid vision routing:** when `llmBackend="on-device"`, route `enrichSharedImage`/`enrichSharedLink`-with-image to OmniRoute anyway (best UX, needs network for vision only) vs. hard-fail vision offline (purest offline story). Recommend hybrid — the dispatcher already has both backends in hand.
- **Runtime choice:** MediaPipe LLM Inference (Google, Gemma-tuned, simplest Android path) vs llama.cpp (most flexible, most build work) vs ExecuTorch. Decide in the Phase 2 spike against real device numbers.
- **Whether to build this at all vs. accept per-call cost.** Ties to AUDIT-backend.md Open Question 2 — if OmniRoute spend never becomes material, this is a privacy/offline feature, not a cost feature, and should be prioritized as such.
