/**
 * Enrichment backend dispatcher (Stage 2 / branch B7, Phase 1).
 *
 * The single seam through which callers reach the six enrichment functions,
 * decoupling them from any one concrete backend. `Settings.llmBackend` selects
 * which backend serves a capture; today only `"omniroute"` is wired, so the
 * dispatcher re-exports the OmniRoute implementations verbatim — the enrich
 * call path and error-classification behavior are byte-identical to importing
 * `./omniroute` directly.
 *
 * Why this exists now, before any second backend: the interface in
 * `omniroute.ts` was shaped for a pluggable backend (both the online capture
 * path and the offline drain path branch ONLY on the `isPermanentError` /
 * `isNotConfiguredError` predicates, never on concrete error types). Extracting
 * this seam de-risks the later phases — the native on-device inference module,
 * the model download lifecycle, and the vision-routing decision — which are
 * separate plans gated behind a hardware spike. When a second backend lands,
 * only this module changes: it grows a `getLlmBackend()`-driven switch that
 * picks the selected backend's functions. Callers do not change again.
 *
 * The two error predicates are re-exported here too, so an updated caller has a
 * single import source for both the enrich functions and the classification it
 * branches on. They remain `OmniRouteError`-based, so `instanceof` checks and
 * predicate logic are preserved exactly.
 */

export {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  promoteIdea,
  isPermanentError,
  isNotConfiguredError,
} from "./omniroute";

export type { EnrichResult } from "./omniroute";
