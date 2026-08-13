# Implementation Report: Journal Places

## Summary
Added the ability to attach multiple named places (each resolved to a name + coordinates)
to a single Journal entry, entered via a pasted Google Maps link (long-form parsed offline,
short-link resolved via a guarded redirect follow) or a typed place name (forward
geocoding). Places are injected into the entry's own markdown body as a `## Places`
section, deliberately not frontmatter, since the existing `location` field is a
day-file-scoped scalar that would clobber a multi-stop travel day.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large — confirmed |
| Confidence | 7/10 | Justified — the data-model/injection-ordering design held up exactly as planned (proven by the real-writer cross-entry test); the flagged uncertainty (Maps URL shape coverage) surfaced real gaps exactly where expected (directions links), caught by review rather than shipped silently wrong |
| Files Changed | 9 (4 new, 5 updated) | 14 (5 new, 9 updated) — the plan undercounted test files and the executor's own judgment call to add a `RedirectResult` type to `urlpreview.ts` |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Export redirect/SSRF primitives from urlpreview.ts | Complete | `followWithRedirects`'s return type changed `Response` → `{response, finalUrl}` (a deviation from the plan's sketch, needed because `Response.url` isn't reliably set under manual-redirect mode in RN/tests) — the one existing caller (`fetchUrlPreview`) was correctly updated |
| 2 | Add resolvePlaceName to location.ts | Complete | Matches plan exactly |
| 3 | Create mapsLink.ts | Complete — 2 review rounds | See Deviations: initial version had a bypassable host-allowlist regex and mis-parsed directions links; both fixed |
| 4 | Add injectPlaces to writer.ts | Complete — 1 review round | Initial version lacked name sanitization and clobbered a pre-existing `## Places` section; both fixed. No circular import — `location.ts` has no dependency back on `writer.ts` |
| 5 | Thread places through captureConfirmSave.ts | Complete | The plan's flagged top risk (cross-entry contamination) is covered by `captureConfirmSavePlaces.test.ts`, which deliberately uses the REAL writer against an in-memory FS rather than mocks, specifically because a mocked writer couldn't prove the real `upsertSection`/`appendJournal` interaction stays entry-scoped |
| 6 | Thread places through offline queue | Complete | Verified the drain path actually applies `injectPlaces`, not just a dangling type field |
| 7 | Build PlacesEditor component | Complete | Ambiguous-geocode results take the first match with an inline note rather than blocking on a full disambiguation picker, per the plan's explicit scope call |
| 8 | Wire places into CaptureMetaSheet + CaptureScreen.tsx | Complete | Journal-only threading verified at the call sites themselves (not just the UI gate) — Idea/Person saves never receive a `places` field |
| Validate | Full validation suite | Complete | Independently re-verified by me after both the initial implementation and the fix round, not taken on the executor's word |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean, `eslint .` clean |
| Unit Tests | Pass | 1713/1713 passing (up from 1703 main-baseline), incl. the critical real-writer cross-entry test |
| Build | Pass | `npm run build:shared` clean |
| Integration | Pass | `verify:capture-flow` — 283/283 |
| Edge Cases | Pass | Directions-link rejection, malformed short-link redirects, pre-existing `## Places` merge, name sanitization all have dedicated tests |
| Security | Pass | Independent adversarial review with ~30k-combination fuzz testing of the host-allowlist regex; zero bypasses found after the fix round |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/mapsLink.ts` | CREATED | ~155 |
| `apps/mobile/src/lib/mapsLink.test.ts` | CREATED | (new) |
| `apps/mobile/src/components/PlacesEditor.tsx` | CREATED | ~140 |
| `apps/mobile/src/components/PlacesEditor.test.tsx` | CREATED | (new) |
| `apps/mobile/src/lib/captureConfirmSavePlaces.test.ts` | CREATED | ~155 — the real-writer cross-entry proof, deliberately its own file (see file's own header comment) |
| `apps/mobile/src/lib/urlpreview.ts` | UPDATED | +26 |
| `apps/mobile/src/lib/location.ts` | UPDATED | +37 |
| `apps/mobile/src/lib/location.test.ts` | UPDATED | +67 |
| `apps/mobile/src/lib/writer.ts` | UPDATED | +80 |
| `apps/mobile/src/lib/writer.test.ts` | UPDATED | +92 |
| `apps/mobile/src/lib/captureConfirmSave.ts` | UPDATED | +16 |
| `apps/mobile/src/lib/captureConfirmSave.test.ts` | UPDATED | +56 |
| `apps/mobile/src/lib/captureConfirmSave.integration.test.ts` | UPDATED | +1 |
| `apps/mobile/src/lib/queue.ts` | UPDATED | +16 |
| `apps/mobile/src/lib/queue.test.ts` | UPDATED | +40 |
| `apps/mobile/src/components/CaptureViews.tsx` | UPDATED | +14 |
| `apps/mobile/src/screens/CaptureScreen.tsx` | UPDATED | +14 |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` | UPDATED | +94 |
| `apps/mobile/test/__stubs__/expo-location.ts` | UPDATED | +4 |

Total: 5 files created, 13 updated.

## Deviations from Plan

1. **`followWithRedirects`'s return type changed** from the plan's assumed `Response` to
   `{response, finalUrl}`. `Response.url` is not reliably populated when fetch is called
   with `redirect: "manual"` on React Native / under the test harness, but `mapsLink.ts`
   needs the actual resolved URL (not just its body) to parse coordinates out of it. This
   is a better design than the plan sketched, not a compromise — it makes the resolved URL
   an explicit, typed return value instead of relying on an unreliable `Response` property.
2. **`isGoogleMapsHost` added as a defense-in-depth allowlist**, beyond what the plan's
   Task 3 pseudocode specified. Good call by the implementer — it prevents a non-Google URL
   from ever reaching the coordinate-parsing regexes at all, independent of the reused SSRF
   guard. Its first version had a real bypass (a prefix-match regex, not anchored to the
   TLD), found and fixed via code review — see Issues Encountered.
3. **Google Maps directions links (`/maps/dir/`) explicitly rejected** rather than parsed —
   not called out in the plan at all, discovered during review. Without this, a directions
   URL would have silently resolved to the viewport midpoint between two waypoints (wrong
   data, not a clean failure) rather than an `invalidLink` outcome.
4. **`injectPlaces` merges into a pre-existing `## Places` section** rather than the plan's
   implicit assumption (mirrored from `injectAttachments`'s Files-section behavior) that
   `upsertSection`'s replace-on-match semantics were fine to reuse as-is. Since the LLM
   enrichment prompt can plausibly generate its own `## Places` heading for a travel entry,
   replacing outright would have silently destroyed model-written content — found via
   review, fixed by reading the existing section back and appending rather than replacing.

## Issues Encountered

An independent code-review pass (not self-approved) found 1 HIGH + 3 MEDIUM + 2 LOW issues
in the first implementation pass — all fixed in one follow-up round, independently
re-verified by me (not taken on the executor's report):

- **HIGH**: `isGoogleMapsHost`'s original regex (`/^(?:www\.|maps\.)?google\.[a-z.]+$/`) was
  a prefix match, not an anchored TLD match — `google.evil.com` and similar hostile domains
  incorrectly passed. Fixed with an exact-suffix check against a known-TLD pattern plus a
  small explicit allowlist for multi-label ccTLDs (`co.uk`, `co.jp`, etc.). Independently
  re-verified by a dedicated security-review pass that fuzz-tested ~30,000 host combinations
  and found zero remaining bypasses.
- **MEDIUM**: unescaped place names could inject a newline or bracket into the vault file,
  in the worst case forging a fake `## ` section boundary. Fixed with `sanitizePlaceName`.
- **MEDIUM**: `/maps/dir/` (directions) links silently produced wrong coordinates (the
  viewport midpoint between two endpoints) instead of failing cleanly. Fixed by explicitly
  rejecting directions-shaped URLs before the coordinate regexes run.
- **MEDIUM**: `injectPlaces` would silently destroy a pre-existing `## Places` section
  (plausible since the enrichment LLM writes travel prose and might emit its own). Fixed to
  merge/append instead of replace.
- **LOW** (both fixed): a comment misstated that `## Places` nests under the entry's
  `## HH:MM` heading (it's actually a sibling, matching `## Files`'s existing behavior —
  the entry-scoping guarantee holds regardless, proven by the cross-entry test); a
  short-link resolution failure (expired/404) surfaced a confusing "not a Maps link" error
  instead of a resolution-failure message — fixed with an explicit `response.ok` check.

Both this session's ongoing pattern of "trust the report, then independently verify
everything" and the new adversarial-security-review step for the HIGH finding paid off
here — the fuzz test specifically confirmed the fix class of bug (prefix-match bypass) is
fully closed, not just the specific reported strings.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/mapsLink.test.ts` | multiple | long-form parsing (place/search/dir path gating), short-link redirect resolution, SSRF-blocked-host rejection, the `google.evil.com`-class bypass strings, malformed/non-Maps URLs |
| `apps/mobile/src/lib/location.test.ts` (extended) | +several | `resolvePlaceName`: single match, no match, ambiguous, thrown error |
| `apps/mobile/src/lib/writer.test.ts` (extended) | +several | `injectPlaces`: empty list no-op, single/multiple places, re-injection merges rather than duplicates, name sanitization (newline/bracket stripping) |
| `apps/mobile/src/lib/captureConfirmSavePlaces.test.ts` | 3 | The critical real-writer cross-entry independence proof — two same-day journal entries with different places each keep their own `## Places` section |
| `apps/mobile/src/lib/queue.test.ts` (extended) | +several | Offline places round-trip through enqueue → drain |
| `apps/mobile/src/components/PlacesEditor.test.tsx` | multiple | add-by-link, add-by-name, remove, each error-outcome message, Add-button disabled-while-resolving |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` (extended) | +several | Journal capture with places produces a note with `## Places`; Idea/Person captures never show the Places UI or thread a `places` field |

## Next Steps
- [ ] Manual on-device validation — paste a REAL Google Maps long-form and short-form
      share link (a unit test can only mock the redirect, not prove the real
      `maps.app.goo.gl` service still redirects the way the mocks assume)
- [ ] Create PR via `/prp-pr`
- [ ] Full-suite `/codex review` pass before merge, matching the process used on the
      sibling `feat/edit-before-after-enrichment` branch this session
