# Implementation Report: URL share preview fetch

## Summary
When a URL is shared into carnet, `enrichSharedLink` now fetches the page
in parallel with the settings reads, extracts `<title>` / `og:*` /
`meta description` / first `<p>`, and threads the metadata into the
prompt. The LLM summarizes from real page content instead of guessing
from URL slugs. Every failure mode (invalid URL, non-200, non-HTML,
network error, timeout, parse error) collapses to a `null` preview so
the URL-string-only fallback path still produces a saved note.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small-to-Medium | Small |
| Files | 3 modified + 1 new + 1 test = 5 | 3 modified + 2 new = 5 |
| Tests added | "full parser coverage + 1 integration case" | +15 parser, +4 integration = +19 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `lib/urlpreview.ts` — fetch + parse + timeout | Complete | 8s AbortController, 256 KB body cap, Mozilla UA, og/twitter/title/desc/first-`<p>` extraction, entity decode, 500-char field trim |
| 2 | `lib/urlpreview.test.ts` | Complete | 15 tests: og happy path, title-only, entity decode, body truncation, non-200, non-HTML, fetch error, AbortError, invalid URL, non-http schemes, empty body, `<p>` fallback, UA, attribute-order, length cap |
| 3 | Extend `buildSharedLinkPrompt` with preview param | Complete | System prompt branches: "use page metadata as primary source" vs "you do NOT have page contents". Preview lines (Site / Page title / Page description) injected into `<USER_INPUT>` envelope so INJECTION_GUARD applies to hostile page content |
| 4 | `enrichSharedLink` parallel fetch | Complete | Added to existing `Promise.all` with the settings reads. `.catch(()=>null)` would be redundant since `fetchUrlPreview` already never throws |
| 5 | (Optional) Sub-state spinner copy | Skipped | Preview returns in ~1-3s on typical pages; not worth the state machine bump |

## Validation Results

| Check | Result |
|---|---|
| Static Analysis (`tsc --noEmit`) | Pass — zero errors |
| Unit Tests (`vitest run`) | **93/93 pass** (was 74; +19) |
| Build | N/A (JS-only — Metro hot-reload picks it up on the device) |
| Manual / On-device | Pending — share an article into carnet, observe the saved markdown has real summary |

## Files Changed

| File | Action | Notes |
|---|---|---|
| `apps/mobile/src/lib/urlpreview.ts` | CREATED | ~160 lines; standalone module, no new dependencies |
| `apps/mobile/src/lib/urlpreview.test.ts` | CREATED | 15 fetch-mocked tests |
| `apps/mobile/src/lib/prompts.ts` | UPDATED | `buildSharedLinkPrompt` gains 4th `preview` param; system prompt copy reworded |
| `apps/mobile/src/lib/omniroute.ts` | UPDATED | `enrichSharedLink` calls `fetchUrlPreview` in parallel with settings |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATED | +4 integration tests for the preview-threading path |

## Deviations from Plan
- **Task 4** plan suggested `.catch(()=>null)` defensiveness; omitted because `fetchUrlPreview` is contractually no-throw. Adding the catch would have just been belt-and-suspenders without informational value.
- **Task 5** (spinner sub-state) skipped — preview fetch is fast and the existing "OmniRoute is enriching + saving…" copy still reads correctly.

## Issues Encountered
- Initial first-`<p>` regex `<p[\s>][^]*?>([^]*?)<\/p>` mis-terminated at the `>` of an inner `<strong>` tag and dropped the first few words. Fixed with `<p(?:\s[^>]*)?>([\s\S]*?)<\/p>` — cleaner attribute consumption. Caught by the test suite immediately.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `urlpreview.test.ts` | 15 | Parser happy path + all 9 failure modes from the plan's edge-case checklist + helpers |
| `omniroute.test.ts` (added) | 4 | Preview-threading + fallback + no-URL skip + empty-preview-not-included |

## Threat Model Note
Page content may contain prompt-injection attempts (`<title>Ignore previous instructions...</title>`). The preview is threaded through `<USER_INPUT>` in `buildSharedLinkPrompt`, so the existing INJECTION_GUARD in the system prompt explicitly treats it as data, not instructions. The preview never lands in the system message.

## Next Steps
- [ ] On-device manual validation: share an article, share a paywalled URL, share offline
- [ ] Code review via `/code-review`
- [ ] PR creation via `/prp-pr`
