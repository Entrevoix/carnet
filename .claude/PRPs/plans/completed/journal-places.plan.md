Status: shipped

# Plan: Journal Places (multi-place tagging for travel entries)

## Summary
Adds the ability to attach multiple named places — each resolved to a name + coordinates —
to a single Journal entry, entered either by pasting a Google Maps share link or typing a
plain place name. Places are resolved client-side (link parsing / redirect-following /
forward geocoding) and injected into the entry's markdown as a `## Places` section of
`[Name](geo:lat,lon)` links, mirroring the existing attachment-injection pattern.

## User Story
As someone who travels a lot and journals about it, I want to attach several places to one
journal entry (not just one GPS point for the whole day), so that a multi-stop travel day
is recorded with the actual places correctly named and geolocated, not lost in prose.

## Problem → Solution
**Current**: Journal entries have exactly one location field, and it is a **day-file-scoped
scalar** — `appendJournal` unconditionally overwrites the day file's single `location`
frontmatter value with whatever the latest same-day capture set (`writer.ts:588-589`:
*"location is a scalar — a day file has one frontmatter, so the latest same-day capture's
location wins"*). A travel day with three stops today either loses two of them or requires
three separate journal captures competing to overwrite the same field. There is also no
forward-geocoding or Maps-link-resolution capability anywhere in the codebase today.

**Desired**: Each journal entry can carry zero or more named places, entered by pasting a
Google Maps link (long-form, parsed directly; or short-form `maps.app.goo.gl`, resolved via
redirect-following) or by typing a place name (resolved via forward geocoding). Places are
injected into the entry's own body — not the day file's frontmatter — so they stay correctly
scoped to the entry that mentions them, survive multiple entries per day file, and render as
clickable links in Obsidian.

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 9 (4 new, 5 updated) + matching test files

---

## UX Design

### Before
```
┌──────────────────────────────────────┐
│ Journal capture                       │
│  [transcript/text input]              │
│  [+] → Tags & details sheet:          │
│    - Tags                             │
│    - Location (ONE GPS chip, whole    │
│      day file, gets clobbered by the  │
│      next same-day capture)           │
│    - Attachments                      │
└──────────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────┐
│ Journal capture                       │
│  [transcript/text input]              │
│  [+] → Tags & details sheet:          │
│    - Tags                             │
│    - Location (unchanged — still the  │
│      one whole-day GPS chip)          │
│    - Places (NEW):                    │
│        [paste Maps link or type name] │
│        [+ Add]                        │
│        chip: "Rud-Alpe Gastronomie" ✕ │
│        chip: "Lech, Austria" ✕        │
│    - Attachments                      │
│                                        │
│  Saved entry body:                    │
│    [prose]                            │
│    ## Places                          │
│    [Rud-Alpe Gastronomie](geo:47.2…)  │
│    [Lech, Austria](geo:47.2…)         │
└──────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `CaptureMetaSheet` (Journal only) | Tags, Location, Attachments | + a "Places" block: text input (paste-or-type) + Add button + removable chips | Idea/Person unaffected — `showPlaces` gated to `mode === "journal"` |
| Journal entry body on disk | Prose only | Prose + a `## Places` section of markdown geo-links | New section, entry-scoped (survives multi-entry days) |
| Existing `location` field | Day-file GPS scalar | **Unchanged** — this plan does not touch it | Explicitly NOT building a replacement; see NOT Building |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/writer.ts` | 560-601 (`appendJournal`), 283-302 (`injectAttachments`), 198-230ish (`upsertSection`) | **Critical**: confirms `location` is day-file-scoped ("latest wins"), and gives the exact pattern (`upsertSection` under a `## Files`-style heading) that `injectPlaces` must mirror for entry-scoped data |
| P0 | `apps/mobile/src/lib/location.ts` | full file (78 lines) | `Coords` type, `formatCoords`/`parseCoords`, and confirms `expo-location`'s `geocodeAsync` (forward geocoding) exists and is currently unused — the primitive this plan needs |
| P0 | `apps/mobile/src/lib/urlpreview.ts` | 489-519 (`isBlockedHost`/SSRF guard), 537-597 (`followWithRedirects`), 607-628 (`fetchWithTimeout`) | The ONLY existing redirect-following + SSRF-guard code in the codebase. **Must be reused, not duplicated** — these are currently module-private; Task 1 exports them |
| P0 | `apps/mobile/src/components/LocationChip.tsx` | full file (131 lines) | Single-value UI pattern (paste/type → chip) to adapt into a multi-value "Places" editor |
| P1 | `apps/mobile/src/lib/captureConfirmSave.ts` | 29-41 (`applyLocation`, `composeMarkdown`), 78-84 (`confirmSaveJournal`) | Exact pipeline order (`injectAttachments` → `mergeUserTags` → `applyLocation`) that `injectPlaces` must be added to |
| P1 | `apps/mobile/src/lib/queue.ts` | 91-101 (`JournalPayload`) | Offline-queue shape that needs a `places` field for parity with `tags`/`location`/`attachments` |
| P1 | `apps/mobile/src/lib/frontmatter.ts` | 431-471 (`getFrontmatterTags`), 490-492 (`setFrontmatterTags`) | Precedent for a list-valued field, confirms why frontmatter is the WRONG place for this data (file-scoped, not entry-scoped) — informs the "NOT Building: places as frontmatter" decision |
| P2 | `apps/mobile/src/lib/urlpreview.test.ts` | full file | `fetchMock`/`globalThis.fetch` mocking pattern to reuse for testing Maps-link redirect resolution |
| P2 | `apps/mobile/src/lib/location.test.ts` | full file (128 lines) | `expo-location` mocking pattern (vitest alias) to reuse for testing `geocodeAsync`-based forward geocoding |
| P2 | `apps/mobile/src/screens/CaptureScreen.tsx` | 726-751 (journal submit), 811-830 (`confirmSave` journal branch) | Exact submit/save call sites `places` state must thread through |

## External Documentation

No web research needed for the core mechanism — `expo-location`'s `geocodeAsync` is already
an installed, typed API (`node_modules/expo-location/build/Location.d.ts:87`). One thing to
verify empirically during implementation (not blocking the plan): the exact URL shapes
Google Maps share links produce (`https://maps.app.goo.gl/...` short links vs.
`https://www.google.com/maps/place/.../@lat,lon,zoom` or `?q=lat,lon` long-form URLs) — the
long-form parsing regex in Task 3 should be validated against a few real shared links from
the phone's Maps app before considering it done, since Google's URL format has changed
before and isn't formally documented.

---

## Patterns to Mirror

### OUTCOME_DISCRIMINATED_UNION
// SOURCE: apps/mobile/src/lib/captureErrorDecision.ts:29-31, apps/mobile/src/lib/cardScanOutcome.ts:16-22
```ts
export type ResolvePlaceOutcome =
  | { kind: "ok"; place: string; coords: Coords }
  | { kind: "ambiguous"; candidates: { place: string; coords: Coords }[] }
  | { kind: "notFound" }
  | { kind: "invalidLink" }
  | { kind: "error"; message: string };
```
This codebase has 5+ examples of this exact `{ kind: "..." }` shape (also
`EnrichIdeaOutcome`, `FinishEnrichmentOutcome`, `saveFirstOutcome.ts:41-44`) — always `kind`,
never `status`/`type`.

### ENTRY_SCOPED_BODY_INJECTION (not frontmatter)
// SOURCE: apps/mobile/src/lib/writer.ts:283-302 (`injectAttachments`), `upsertSection`
```ts
export function injectAttachments(markdown: string, attachments: readonly AttachmentRef[]): string {
  let md = markdown;
  // ...images injected as embeds...
  const files = attachments.filter((a) => a.kind === "file");
  if (files.length > 0) {
    const body = files.map((f) => `[${f.filename}](${f.rel})`).join("\n\n");
    md = upsertSection(md, "Files", body);
  }
  return md;
}
```
`injectPlaces` follows this exactly: a list of `[name](geo:lat,lon)` links joined and
inserted via `upsertSection(md, "Places", body)`. This runs on the ENTRY's own markdown
fragment, before `appendJournal` strips its frontmatter and appends it under the day file's
`## HH:MM` heading — so the `## Places` section lands correctly scoped inside that entry's
section, not the day file's shared frontmatter.

### CAPTURE_PIPELINE_ORDER
// SOURCE: apps/mobile/src/lib/captureConfirmSave.ts:34-41
```ts
function composeMarkdown(markdown: string, refs: AttachmentRef[], tags: string[], location: string | null): string {
  return applyLocation(mergeUserTags(injectAttachments(markdown, refs), tags), location);
}
```
`injectPlaces` is added as one more step in this fixed pipeline order (attachments → tags →
location → **places**), inside `confirmSaveJournal` specifically (Idea/Person don't get
places per this plan's scope).

### SSRF_GUARDED_REDIRECT_FOLLOW
// SOURCE: apps/mobile/src/lib/urlpreview.ts:537-597
```ts
async function followWithRedirects(startUrl: string, signal: AbortSignal): Promise<Response> {
  // ...MAX_REDIRECTS = 5, REDIRECT_STATUSES = new Set([301,302,303,307,308])...
  // SSRF guard on EVERY hop — re-validates the Location header target via isBlockedHost
  // before following, not just the original URL.
}
```
**GOTCHA**: `followWithRedirects`/`isBlockedHost`/`extractHost` are currently
**module-private** to `urlpreview.ts` (only `__ssrfGuardInternals` is exported, and only for
tests). Task 1 exports them properly for reuse — do NOT copy/reimplement this logic in the
new Maps-link module. SSRF guards duplicated across two files is exactly the kind of drift
this codebase's own `httpClient.ts` docstring says a prior architecture audit already
flagged once (see `httpClient.ts:1-16`).

### FETCH_MOCK_TEST_PATTERN
// SOURCE: apps/mobile/src/lib/urlpreview.test.ts:3-4
```ts
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
// per-test: fetchMock.mockResolvedValueOnce(...) / mockRejectedValueOnce(...)
```

### EXPO_LOCATION_MOCK_TEST_PATTERN
// SOURCE: apps/mobile/src/lib/location.test.ts:1-16
```ts
// expo-location is aliased to a vitest stub (vitest.config.ts); import the named exports
// and drive them with vi.mocked(fn).mockResolvedValue(...). Partial mock payloads go
// through `as unknown as X` casts since tsc resolves the real (strict) types.
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/urlpreview.ts` | UPDATE | Export `followWithRedirects`, `isBlockedHost`, `extractHost` (or refactor into a small shared internal module both files import) so the redirect/SSRF logic has exactly one implementation |
| `apps/mobile/src/lib/mapsLink.ts` | CREATE | `resolveMapsLink(url): Promise<ResolvePlaceOutcome>` — long-form URL regex parse; short-form redirect-follow via the exported `urlpreview.ts` primitives |
| `apps/mobile/src/lib/mapsLink.test.ts` | CREATE | Tests for long-form parsing (multiple real-world URL shapes), short-link redirect resolution (mocked fetch), SSRF-blocked-host rejection, malformed/non-Maps URL handling |
| `apps/mobile/src/lib/location.ts` | UPDATE | Add `resolvePlaceName(name): Promise<ResolvePlaceOutcome>` wrapping `geocodeAsync`, reusing the existing `Coords` type |
| `apps/mobile/src/lib/location.test.ts` | UPDATE | Tests for `resolvePlaceName`: success, no-match, multiple-candidates (`ambiguous`), thrown-error paths |
| `apps/mobile/src/lib/writer.ts` | UPDATE | Add `injectPlaces(markdown, places: Place[]): string` mirroring `injectAttachments`'s `upsertSection(md, "Files", ...)` pattern for a `## Places` section |
| `apps/mobile/src/lib/writer.test.ts` | UPDATE | Tests for `injectPlaces`: empty list is a no-op, single place, multiple places, re-injection updates rather than duplicates the section (same `upsertSection` idempotency `injectAttachments`'s Files section already relies on) |
| `apps/mobile/src/lib/captureConfirmSave.ts` | UPDATE | Thread `places: Place[]` through `ConfirmSaveJournalInput`/`composeMarkdown`, calling `injectPlaces` after `applyLocation` |
| `apps/mobile/src/lib/captureConfirmSave.test.ts` | UPDATE | Test the new pipeline step's ordering and no-op-when-empty behavior |
| `apps/mobile/src/lib/queue.ts` | UPDATE | Add `places?: Place[]` to `JournalPayload`; thread through the offline-drain path the same way `tags`/`location`/`attachments` already are |
| `apps/mobile/src/lib/queue.test.ts` | UPDATE | Test places survive an offline enqueue → drain cycle |
| `apps/mobile/src/components/PlacesEditor.tsx` | CREATE | New component: paste-or-type input + Add button + removable place chips. Presentational only, mirrors `LocationChip.tsx`'s structure but multi-value |
| `apps/mobile/src/components/PlacesEditor.test.tsx` | CREATE | Smoke test: add-by-link, add-by-name, remove, resolution-failure error display |
| `apps/mobile/src/components/CaptureViews.tsx` | UPDATE | `CaptureMetaSheetProps` gains `places`/`onPlacesChange` (Journal-only, mirroring the existing `showAttachments` gate pattern used for `pending`/`savedAttachments`) |
| `apps/mobile/src/components/CaptureViews.test.tsx` (or wherever `CaptureMetaSheet` is tested, if separate) | UPDATE | Render test confirming Places block only shows for `mode === "journal"` |
| `apps/mobile/src/screens/CaptureScreen.tsx` | UPDATE | New `places` state (Journal-only), wired to `PlacesEditor`/`CaptureMetaSheet`, threaded into `confirmSaveJournal` and the offline `enqueue` call |
| `apps/mobile/src/screens/CaptureScreen.test.tsx` | UPDATE | Test a Journal capture with 2 places produces a body containing both as `## Places` links; test Idea/Person captures are unaffected |

## NOT Building
- Places as a frontmatter field — explicitly rejected; `writer.ts:588-589` confirms
  `location` frontmatter is day-file-scoped and gets clobbered by same-day captures, which
  is exactly the bug this feature exists to avoid repeating for multiple places
- Any change to the existing single `location`/`LocationChip` GPS field — it stays exactly
  as-is, for the same "roughly where was I" whole-day use case it already serves
- Places for Idea or Person capture modes — scoped to Journal only per this session's
  explicit decision; the underlying `injectPlaces`/`resolveMapsLink`/`resolvePlaceName`
  primitives are mode-agnostic and could be wired to other modes later without rework
- A map view / visualization of places — this plan only captures and persists place data as
  markdown links; rendering a map is separate, future scope
- Editing/re-resolving a place after it's added to the list (only add/remove) — if the
  resolved name or coordinates are wrong, the user removes and re-adds
- Reverse-geocoding coordinates back to a display name for typed lat/lon input — out of
  scope; typed input goes through forward geocoding only (a name → coords), not the
  lat/lon-paste path `LocationChip` already has (that pattern isn't being extended here)
- Plus Codes support (Google's short offline geocode format, e.g. `646M+9V Lech, Austria`)
  — raised and explicitly descoped in an earlier planning session this same day; this
  plan's Maps-link/typed-name mechanism is a different, simpler input path and doesn't
  preclude adding Plus Codes support later as a third input method

---

## Step-by-Step Tasks

### Task 1: Export the redirect-following + SSRF-guard primitives from `urlpreview.ts`
- **ACTION**: Make `followWithRedirects`, `isBlockedHost`, `extractHost` importable from
  outside `urlpreview.ts` without duplicating their logic.
- **IMPLEMENT**: Simplest path: add `export` to each function in place (they're currently
  plain `function`/`async function` declarations, not `export`ed — confirm no naming
  collisions this creates with `urlpreview.ts`'s existing public API). Cleaner alternative
  if time allows: extract all three (plus their `MAX_REDIRECTS`/`REDIRECT_STATUSES`
  constants and the IPv4/IPv6/IDNA canonicalization helpers they depend on) into a new
  `apps/mobile/src/lib/safeFetch.ts`, and have both `urlpreview.ts` and the new
  `mapsLink.ts` import from there. Prefer the extraction if the dependency chain is small
  and self-contained; fall back to plain `export` if the helpers are entangled with
  `urlpreview.ts`-specific state.
- **MIRROR**: `httpClient.ts`'s own docstring (lines 1-16) — this codebase has already
  consolidated duplicated hardening once before; treat that as the precedent for doing it
  again here rather than letting a third fetch-timeout/redirect implementation exist.
- **IMPORTS**: N/A (internal refactor)
- **GOTCHA**: `isBlockedHost` re-validates the SSRF guard on every redirect hop, not just
  the initial URL — this is the exact behavior Maps-link resolution also needs (a malicious
  or compromised short-link service could redirect to an internal host), so do not simplify
  it away during extraction.
- **VALIDATE**: `npm -w @carnet/mobile test -- urlpreview` — existing tests must still pass
  unchanged after the export/extraction (pure refactor, no behavior change).

### Task 2: Add forward geocoding to `location.ts`
- **ACTION**: Add `resolvePlaceName(name: string): Promise<ResolvePlaceOutcome>`.
- **IMPLEMENT**:
  ```ts
  export async function resolvePlaceName(name: string): Promise<ResolvePlaceOutcome> {
    const trimmed = name.trim();
    if (!trimmed) return { kind: "notFound" };
    try {
      const results = await Location.geocodeAsync(trimmed);
      if (results.length === 0) return { kind: "notFound" };
      if (results.length === 1) {
        return { kind: "ok", place: trimmed, coords: { lat: results[0].latitude, lon: results[0].longitude } };
      }
      return {
        kind: "ambiguous",
        candidates: results.map((r) => ({ place: trimmed, coords: { lat: r.latitude, lon: r.longitude } })),
      };
    } catch (e: unknown) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }
  ```
- **MIRROR**: `getCurrentCoords()` (`location.ts:42-58`) for the try/catch-never-throws
  shape; `describeCoords()` for the `Location.*Async` call pattern.
- **IMPORTS**: `Location` from `expo-location` (already imported in this file).
- **GOTCHA**: `geocodeAsync` results don't carry a display name back — `results[0]` is just
  `{ latitude, longitude, accuracy, altitude }` (per the `.d.ts`), not a place label. The
  `place` field in the outcome is therefore the user's TYPED input echoed back, not a
  geocoder-confirmed canonical name. This is fine for this feature (the user typed a name
  they recognize) but do not assume `results[0]` has richer data than it does.
- **VALIDATE**: `npm -w @carnet/mobile test -- location` — new tests: single match →
  `"ok"`, zero matches → `"notFound"`, multiple matches → `"ambiguous"` with all candidates,
  thrown error → `"error"` with message.

### Task 3: Create `mapsLink.ts` for Google Maps link resolution
- **ACTION**: Parse a pasted Google Maps URL into a place + coordinates, handling both
  long-form (coords embedded directly) and short-form (`maps.app.goo.gl`, needs a redirect
  follow) links.
- **IMPLEMENT**:
  ```ts
  const LONG_FORM_COORD_RE = /@(-?\d+\.\d+),(-?\d+\.\d+)/; // .../@47.2011,10.1166,15z
  const QUERY_COORD_RE = /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/; // ...?q=47.2011,10.1166
  const PLACE_NAME_RE = /\/place\/([^/@]+)/; // .../place/Rud-Alpe+Gastronomie/@...

  export async function resolveMapsLink(url: string): Promise<ResolvePlaceOutcome> {
    let target = url.trim();
    if (!/^https?:\/\//i.test(target)) return { kind: "invalidLink" };
    if (/^https?:\/\/maps\.app\.goo\.gl\//i.test(target)) {
      // Short link — follow redirects via the exported urlpreview.ts primitives (Task 1),
      // same SSRF-guarded hop-by-hop validation, same MAX_REDIRECTS.
      const resolved = await followRedirectsForUrl(target); // wraps followWithRedirects + timeout
      if (!resolved) return { kind: "error", message: "Could not resolve the Maps link." };
      target = resolved;
    }
    const coordMatch = LONG_FORM_COORD_RE.exec(target) ?? QUERY_COORD_RE.exec(target);
    if (!coordMatch) return { kind: "invalidLink" };
    const coords = { lat: parseFloat(coordMatch[1]), lon: parseFloat(coordMatch[2]) };
    const nameMatch = PLACE_NAME_RE.exec(target);
    const place = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, " ")) : formatCoords(coords);
    return { kind: "ok", place, coords };
  }
  ```
  Adjust regexes against real captured share links per the External Documentation note
  before finalizing — Google's URL shapes are not formally documented and may need a third
  or fourth pattern.
- **MIRROR**: `urlpreview.ts:635-701` (`fetchUrlPreview`)'s never-throws, collapse-every-
  failure-to-a-typed-outcome shape.
- **IMPORTS**: the exported `followWithRedirects`/`isBlockedHost` (or `safeFetch.ts`, per
  Task 1's outcome) from `urlpreview.ts`; `formatCoords` from `./location`.
- **GOTCHA**: apply the SAME SSRF host-block guard to the short-link redirect target that
  `urlpreview.ts` already applies — a Maps-link resolver is just as reachable an SSRF vector
  as the existing URL-preview feature, and must not get a weaker guard just because it's a
  different file.
- **VALIDATE**: `npm -w @carnet/mobile test -- mapsLink` — long-form URL with `@lat,lon`,
  long-form with `?q=`, short-link redirecting to a long-form URL (mocked fetch per the
  `urlpreview.test.ts` pattern), non-Maps URL → `invalidLink`, short-link redirecting to a
  blocked host → `error` (SSRF guard fires).

### Task 4: Add `injectPlaces` to `writer.ts`
- **ACTION**: Inject a list of places into an entry's markdown body as a `## Places`
  section, mirroring `injectAttachments`'s `## Files` section.
- **IMPLEMENT**:
  ```ts
  export interface Place {
    name: string;
    coords: Coords;
  }

  export function injectPlaces(markdown: string, places: readonly Place[]): string {
    if (places.length === 0) return markdown;
    const body = places
      .map((p) => `[${p.name}](geo:${formatCoords(p.coords)})`)
      .join("\n\n");
    return upsertSection(markdown, "Places", body);
  }
  ```
- **MIRROR**: `injectAttachments` (`writer.ts:283-302`) exactly — same `upsertSection`
  call shape, same blank-line-between-links spacing rationale (comment at line 296-297
  explains why: adjacent links soft-break onto one line in raw markdown otherwise).
- **IMPORTS**: `Coords`, `formatCoords` from `./location` (new cross-import — confirm no
  circular dependency: `location.ts` must not import from `writer.ts`; check before adding).
- **GOTCHA**: `geo:` is not a registered/standard URI scheme Obsidian specially handles —
  it will render as a plain (non-clickable-to-a-map) markdown link showing coordinates in
  the URL. This is intentional and sufficient for this plan (the goal is structured,
  parseable data on disk, not necessarily a tappable map link) — do not scope-creep into
  building a custom Obsidian plugin or `geo:` URI handler.
- **VALIDATE**: `npm -w @carnet/mobile test -- writer` — empty list is a no-op (returns
  input unchanged), single place, multiple places (correct blank-line spacing), calling
  `injectPlaces` twice with different lists updates the section rather than duplicating it
  (relies on `upsertSection`'s existing idempotent heading-replace behavior).

### Task 5: Thread `places` through `captureConfirmSave.ts`
- **ACTION**: Add `places: Place[]` to journal save, applied after `applyLocation` in the
  compose pipeline.
- **IMPLEMENT**: Extend `ConfirmSaveJournalInput` with `places: Place[]`; in
  `confirmSaveJournal`, change the compose call to
  `applyLocation(mergeUserTags(injectAttachments(markdown, refs), tags), location)` →
  add `injectPlaces(..., places)` as the final step. Idea/Person save functions are
  untouched (no `places` param).
- **MIRROR**: `composeMarkdown` (`captureConfirmSave.ts:34-41`) — same fixed pipeline-order
  pattern, one more step appended at the end.
- **IMPORTS**: `injectPlaces`, `type Place` from `../lib/writer`.
- **GOTCHA**: places must be injected into the ENTRY's own markdown (pre-`appendJournal`),
  not into the day file after accumulation — otherwise a second same-day capture's
  `appendJournal` call would either duplicate the `## Places` heading search across the
  wrong scope or (per `upsertSection`'s single-heading-per-document behavior) incorrectly
  overwrite entry A's places with entry B's when both land in the same day file. Confirm
  this ordering with a test that appends two journal entries with different places to the
  same day and asserts BOTH entries' place sections survive independently, each nested
  under its own `## HH:MM` heading.
- **VALIDATE**: `npm -w @carnet/mobile test -- captureConfirmSave` — the two-same-day-
  entries-different-places test above is the critical one.

### Task 6: Thread `places` through the offline queue
- **ACTION**: Add `places?: Place[]` to `JournalPayload`, mirroring `tags`/`location`.
- **IMPLEMENT**: Add the field to the interface (`queue.ts:91-101`); thread it through
  wherever `JournalPayload` is constructed (`CaptureScreen.tsx`'s offline `enqueue` call)
  and wherever the drain path reconstructs a journal save call (find and follow the
  existing `tags`/`location` threading through the drain function — not read in this
  plan's research pass, verify during implementation).
- **MIRROR**: The existing `tags?: string[]` / `location?: string` fields immediately
  above in the same interface.
- **IMPORTS**: `type Place` from `../lib/writer`.
- **GOTCHA**: `AttachmentRef[]` is already optional (`attachments?:`) in this interface for
  the same reason — an offline capture may have zero attachments/places; don't make the
  field required.
- **VALIDATE**: `npm -w @carnet/mobile test -- queue` — an enqueued journal payload with
  places, drained later, produces a note whose body contains the `## Places` section.

### Task 7: Build the `PlacesEditor` component
- **ACTION**: New presentational component — paste-a-link-or-type-a-name input, Add
  button, list of removable place chips, error display for resolution failures.
- **IMPLEMENT**: Structure mirrors `LocationChip.tsx` but multi-value:
  ```tsx
  interface PlacesEditorProps {
    places: Place[];
    onChange: (places: Place[]) => void;
  }
  ```
  Text input + "Add" button; on submit, detect input shape (`/^https?:\/\//i.test(text)` →
  `resolveMapsLink`, else → `resolvePlaceName`), await the outcome, on `"ok"` append to
  `places` and clear the input, on `"ambiguous"` surface a lightweight disambiguation
  (simplest: just take the first candidate and note in a HelperText that other matches
  existed — a full picker UI is more than this plan needs, flag as a possible follow-up if
  ambiguity turns out to be common in practice), on `"notFound"`/`"invalidLink"`/`"error"`
  show an inline error matching `LocationChip`'s existing error-message pattern
  (`"Enter coordinates as lat,lon..."` style — HelperText, not a toast/Alert, per this
  codebase's established error-surfacing convention).
- **MIRROR**: `LocationChip.tsx` end to end — its `manualOpen`/`commitManual` toggle
  pattern, its `Chip`/`onClose` removable-chip rendering, its HelperText error display.
- **IMPORTS**: `resolveMapsLink` from `../lib/mapsLink`; `resolvePlaceName` from
  `../lib/location`; `type Place` from `../lib/writer`.
- **GOTCHA**: both resolution calls are async and hit network (geocoding) or network+
  redirect-follow (Maps link) — show a loading state on the Add button (disable + spinner)
  matching how other async submit buttons in this codebase behave (e.g. `CaptureScreen`'s
  Send button `disabled={!canSubmit}` pattern) rather than leaving it tappable mid-resolve.
- **VALIDATE**: `npm -w @carnet/mobile test -- PlacesEditor` — add via link (mocked
  `resolveMapsLink`), add via name (mocked `resolvePlaceName`), remove, each error outcome
  surfaces its message, Add button disabled while resolving.

### Task 8: Wire `places` into `CaptureMetaSheet` (Journal-only) and `CaptureScreen.tsx`
- **ACTION**: Add a `places`/`onPlacesChange` prop pair to `CaptureMetaSheetProps`, gated
  to Journal mode; add `places` state to `CaptureScreen.tsx`.
- **IMPLEMENT**: In `CaptureViews.tsx`, add `showPlaces: boolean` (passed as
  `mode === "journal"` from the screen, mirroring `showAttachments={mode !== "person"}`'s
  existing gating pattern) and render `<PlacesEditor places={places} onChange={onPlacesChange} />`
  inside the sheet when `showPlaces` is true. In `CaptureScreen.tsx`, add
  `const [places, setPlaces] = useState<Place[]>([]);` near the existing `pending`/`tags`
  state, thread it into `confirmSaveJournal`'s call and the offline `enqueue` call (Task 6),
  and clear it at every `setPending([])`/reset site (mirroring this session's earlier fix
  for `savedAttachments` — search for all `setPending\(\[\]\)` call sites and add
  `setPlaces([])` alongside each, consistent with how that pattern was just established).
- **MIRROR**: The `savedAttachments` wiring pattern added earlier this session (state
  declaration near `pending`, threaded into the meta sheet's props, cleared at every reset
  site) — same shape, same rationale (don't leave stale state visible across captures).
- **IMPORTS**: `type Place` from `../lib/writer`.
- **GOTCHA**: do NOT thread `places` into Idea or Person's save/enqueue calls — those modes
  don't get this feature per NOT Building. Guard with `mode === "journal"` at the call
  sites, not just the UI gate, so a stray Idea capture never silently carries an empty
  `places: []` into a payload shape that doesn't expect it.
- **VALIDATE**: `npm -w @carnet/mobile test -- CaptureScreen` — a Journal capture with 2
  places produces a saved note containing both under `## Places`; an Idea capture with the
  meta sheet open never shows a Places block at all.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `resolvePlaceName` single match | `"Rud-Alpe Gastronomie"` | `{kind:"ok", place, coords}` | — |
| `resolvePlaceName` no match | `"asdkjfhaskdjf"` | `{kind:"notFound"}` | Yes |
| `resolvePlaceName` ambiguous | a name matching multiple places | `{kind:"ambiguous", candidates:[...]}` | Yes |
| `resolveMapsLink` long-form `@lat,lon` | a captured real share link | `{kind:"ok", ...}` with correct coords | — |
| `resolveMapsLink` short-link redirect | mocked 302 → long-form URL | `{kind:"ok", ...}` | Yes — network |
| `resolveMapsLink` SSRF-blocked redirect target | mocked 302 → internal host | `{kind:"error", ...}`, guard fires | Yes — security |
| `resolveMapsLink` non-Maps URL | `"https://example.com"` | `{kind:"invalidLink"}` | Yes |
| `injectPlaces` empty list | `[]` | markdown unchanged | Yes |
| `injectPlaces` re-injection | call twice, different lists | second call's places win, no duplicate heading | Yes |
| Two same-day journal entries, different places | entry A + places A, entry B + places B | day file has both entries, each with its OWN `## Places` correctly scoped | Yes — the critical cross-entry test |
| Offline places round-trip | enqueue with places, drain | resulting note has `## Places` | Yes |

### Edge Cases Checklist
- [x] Empty input (no places added — `injectPlaces([])` no-op)
- [x] Maximum size input — not bounded in this plan; note as an accepted gap, not a task
- [ ] Invalid types — N/A, TypeScript-enforced
- [x] Concurrent access — the two-same-day-entries test covers the realistic concurrency
      case (sequential captures, not simultaneous)
- [x] Network failure — `resolveMapsLink`/`resolvePlaceName` both collapse every failure to
      a typed outcome, never throw
- [ ] Permission denied — N/A, forward geocoding doesn't need location permission (unlike
      `getCurrentCoords`); confirm this is actually true for `geocodeAsync` during Task 2,
      don't assume

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
npm -w @carnet/mobile test -- urlpreview mapsLink location writer captureConfirmSave queue PlacesEditor CaptureScreen
```
EXPECT: All tests pass, including every new test added across Tasks 1-8

### Full Test Suite
```bash
npm -w @carnet/mobile test
npm -w @carnet/mobile run verify:capture-flow
```
EXPECT: No regressions

### Lint
```bash
npm -w @carnet/mobile run lint
```
EXPECT: Zero violations

### Manual Validation
- [ ] Capture a Journal entry, paste a real Google Maps long-form share link into Places,
      confirm it resolves to a correct place name + coordinates
- [ ] Paste a real Google Maps SHORT link (`maps.app.goo.gl/...`), confirm it resolves
      correctly (this exercises the redirect-follow path a unit test can only mock)
- [ ] Type a plain place name with no link, confirm forward geocoding resolves it
- [ ] Add 2-3 places to one entry, save, open the note's raw markdown, confirm all appear
      under one `## Places` section as separate links
- [ ] Capture a SECOND journal entry the same day with DIFFERENT places, confirm the day
      file now has two `## HH:MM` sections each with their own correct `## Places` list
- [ ] Confirm the existing single `location` GPS chip still works unchanged
- [ ] Confirm Idea and Person capture screens show no Places UI at all

---

## Acceptance Criteria
- [ ] All 8 tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] No type errors
- [ ] No lint errors
- [ ] Matches UX design — Places block Journal-only, existing Location field untouched

## Completion Checklist
- [ ] Code follows discovered patterns (`{kind:...}` outcomes, `upsertSection`-based body
      injection, never-throws async resolution functions)
- [ ] Error handling matches codebase style (HelperText inline, not Alert/toast)
- [ ] SSRF guard reused from `urlpreview.ts`, not duplicated
- [ ] No hardcoded values
- [ ] No unnecessary scope additions — map view, place editing, Idea/Person support, Plus
      Codes all explicitly deferred per NOT Building
- [ ] Self-contained — the only unresolved item is validating the Maps-link regexes
      against real captured share links (External Documentation note), which is a
      validate-during-implementation step, not a missing design decision

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google Maps URL formats drift or have more shapes than the two regexes in Task 3 cover | Medium | Medium — some links fail to parse, user sees `invalidLink` | Validate against several real captured share links before considering Task 3 done (per External Documentation note); the outcome union already has a clean failure path, so an unparseable link fails safely rather than crashing |
| `geocodeAsync` returns coarse/wrong results for ambiguous short names (e.g. "Main Street") | Medium | Low-Medium — wrong coordinates saved | The `"ambiguous"` outcome exists for this; Task 7's UI takes the first candidate with a note that others existed rather than silently picking wrong — full disambiguation UI flagged as a possible follow-up, not blocking |
| Two same-day journal entries' places sections collide via `upsertSection`'s single-heading-per-document behavior | Medium | High — data loss (one entry's places silently overwritten) | This is the single most important test in the plan (Task 5's VALIDATE) — do not consider Task 5 done until this specific test passes |
| Maps-link redirect-following becomes a second SSRF surface if the export/extraction in Task 1 is done sloppily | Low | High — security | Task 1's GOTCHA is explicit: reuse, do not reimplement; the extraction should be a pure refactor with `urlpreview.ts`'s existing tests as the regression guard |

## Notes
This plan intentionally keeps the existing single `location` GPS field completely
untouched — it serves a different purpose (a quick "roughly here" stamp for any capture
mode) than Places (multiple named, precisely resolved stops within one Journal entry).
Earlier the same session, a Plus Codes (Google's offline short-geocode format) feature was
discussed and explicitly descoped from a different plan; this Places feature's
`resolveMapsLink`/`resolvePlaceName` split leaves room for a Plus Codes input path to be
added later as a third resolution method without restructuring anything here.
