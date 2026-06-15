# Plan: Karakeep export — show ALL note photos inline

## Summary
After a note is exported to Karakeep, rewrite the image links in the bookmark's **text body** from carnet's vault-relative form (`![](../Photos/x.jpg)`, which Karakeep can't resolve) to the **uploaded asset's Karakeep URL**, so every image renders inline in the rendered markdown — not just the first one (which the `bannerImage` cover already shows). The note's on-device markdown is untouched; only the copy sent to Karakeep is rewritten.

## User Story
As a carnet user who exports a multi-photo note to Karakeep,
I want **all** my photos to appear in the Karakeep bookmark (where they sit in the text),
So that the bookmark is a faithful copy of my note, not just text + a single cover image.

## Problem → Solution
**Current (after the `bannerImage` cover change, commit `cdfa53e`):** images upload as real assets and the *first* one shows as the bookmark cover (`bannerImage`). The bookmark text still contains `![](../Photos/x.jpg)` — relative vault paths Karakeep's renderer can't resolve, so they show as broken/nothing. A 3-photo note shows 1 cover photo; photos 2–3 are attached-but-hidden (`userUploaded`).
**Desired:** the exported bookmark text references each image by its Karakeep asset URL, so the renderer shows every image inline in the body. Cover (banner) stays as the top-of-card preview; the body shows the full set.

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A (continues `rich-content-attachments.plan.md` Phase 2 — Karakeep export)
- **Depends on:** the multipart-upload crash fix (`2ccf244`) + the `bannerImage` cover (`cdfa53e`) — both on branch `fix/karakeep-multipart-sharedarraybuffer-crash`. Land those first.
- **Estimated Files:** 3 modified + 1 new + 2 test = ~6
- **⚠️ Has a load-bearing unknown (Task 0):** the exact asset URL that renders inline in Karakeep markdown is unverified — resolve it against the live instance before building.

---

## UX Design
Internal change; the user-visible result is "my photos show in Karakeep."

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Export multi-photo note → Karakeep bookmark | Text + 1 cover photo; rest hidden | Text + cover + every photo inline in the body | Same "Send to Karakeep" flow |
| Re-export | (same) | Body re-rewritten to the same asset URLs (idempotent) | No duplicate images |
| Note on device | unchanged | unchanged | We rewrite only the Karakeep copy, never the vault file |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/karakeepExport.ts` | `pushNoteAttachments` (full) | Where images are uploaded; the new rewrite hooks in right after. Already computes the per-image upload. |
| P0 | `apps/mobile/src/lib/karakeep.ts` | `createTextBookmark` / `updateTextBookmark` / `attachAssetToBookmark` / `karakeepFetch` / `karakeepSendJson` (~240–390) | Client shape to add a `getBookmark`/asset-list read + reuse the JSON-fetch hardening |
| P0 | `apps/mobile/src/lib/writer.ts` | `listPairedBinaries`, `PAIRED_BINARY_LINK`, `injectImageEmbed`, `stripPairedBinaryLinks` (~377–520) | The exact `![](../{subdir}/{file})` link grammar to match + rewrite |
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | `runKarakeepExport` (~342–440) | The create/update → attachTags → pushNoteAttachments order the rewrite slots into |
| P1 | `apps/mobile/src/lib/karakeep.test.ts` | full | `MockXHR` + `fetchMock` test shape to mirror for the new client read |
| P1 | git `cdfa53e` (the `bannerImage` commit) | diff | How the cover is set; the inline rewrite is complementary, not a replacement |

## External Documentation
- **Karakeep asset-serving URL** — the one thing to confirm live. The REST API serves bytes at `GET /api/v1/assets/{id}` (Bearer). The **web markdown renderer** almost certainly uses a different, cookie-authed path (Karakeep/Hoarder typically serve UI assets at `/api/assets/{id}`). Task 0 verifies which URL form actually renders in `![]()`. If unsure, check the Karakeep (karakeep-app/karakeep) source for the asset route + whether the markdown renderer allow-lists image hosts (CSP).

---

## Patterns to Mirror

### PAIRED_IMAGE_LINK_GRAMMAR
```ts
// SOURCE: apps/mobile/src/lib/writer.ts — listPairedBinaries / PAIRED_BINARY_LINK
// Image embeds in the note body look like:  ![](../Photos/<filename>)  or  ![alt](../Photos/<filename>)
// Files look like:  [name](../Files/<filename>)
// listPairedBinaries(body) already yields { subdir: "Photos"|"Files"|"Audio", filename, rel: "../{subdir}/{filename}" }
```

### KARAKEEP_JSON_READ (new — mirror existing client)
```ts
// SOURCE: apps/mobile/src/lib/karakeep.ts — karakeepSendJson / parseErrorBody hardening
// Add a GET helper alongside POST/PATCH. Reuse getKarakeepConfig + assertHttpsOrLocal + withTimeout + KarakeepError.
export async function getBookmarkAssets(id: string): Promise<Array<{ id: string; fileName: string; assetType: string }>>;
// GET /api/v1/bookmarks/{id} → json.assets
```

### IDEMPOTENT_FIELD_REWRITE
```ts
// SOURCE: apps/mobile/src/lib/writer.ts — stripPairedBinaryLinks (whole-line regex on ../{subdir}/{file})
// The rewrite is pure + idempotent: each export sends the ORIGINAL note body (../Photos/x), then re-rewrites
// to the asset URL. Karakeep always ends with the inlined version; the vault note is never touched.
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/karakeepInline.ts` | CREATE | Pure helper `rewriteImageLinksToAssets(body, fileNameToUrl): string` — replaces `![alt](../Photos/<file>)` with `![alt](<assetUrl>)` for known files; leaves unknown/Files links untouched. No RN/expo imports → unit-testable. |
| `apps/mobile/src/lib/karakeepInline.test.ts` | CREATE | Cover the rewrite: single/multi image, alt text preserved, unknown file left alone, idempotency, no-image no-op, special chars in filename. |
| `apps/mobile/src/lib/karakeep.ts` | UPDATE | Add `getBookmarkAssets(id)` (GET helper) + `assetInlineUrl(assetId)` builder (origin from the configured `karakeepUrl`, per Task 0). |
| `apps/mobile/src/lib/karakeepExport.ts` | UPDATE | New `inlineNoteImages(bookmarkId, noteBody): Promise<string | null>` (or fold into the export flow): after `pushNoteAttachments`, read the bookmark's assets, build fileName→assetUrl, rewrite the body, `updateTextBookmark` with the inlined text. |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | Call the inline step after `pushNoteAttachments`; fold any error into the existing `assetError` snackbar path (never block the export). |
| `apps/mobile/src/lib/karakeepExport.test.ts` | UPDATE | Add cases for the inline orchestration (mock `getBookmarkAssets`, assert `updateTextBookmark` called with rewritten body). |

## NOT Building
- **Rewriting the on-device vault note.** We only rewrite the copy sent to Karakeep. The vault keeps `../Photos/x` (Obsidian-resolvable).
- **Inlining `../Files/*` (PDFs etc.).** Images only for v1. Files stay attached (`userUploaded`). A later pass could turn `[name](../Files/x)` into a Karakeep asset download link.
- **Local asset-sync record schema change.** We read the asset→id map from Karakeep (`getBookmarkAssets`) — server truth — rather than upgrading the `Set<key>` record to a map. Avoids a v1→v2 migration.
- **Markdown image positioning fidelity beyond the link swap.** We replace the URL in place; layout is whatever Karakeep's renderer does.
- **Removing the `bannerImage` cover.** Cover stays (top-of-card); inline is additive. (Decision point: whether to ALSO inline the cover image's link or skip it to avoid showing it twice — see Task 3.)

---

## Step-by-Step Tasks

### Task 0 — SPIKE: confirm which asset URL renders inline (DO THIS FIRST)
- **ACTION:** Against the live instance (`https://keep.grepon.cc`, key in Settings/SecureStore — rotate after), on a test bookmark that already has an uploaded image asset, `PATCH /api/v1/bookmarks/{id}` setting `text` to include `![](<candidate>)` and check the rendered bookmark in the Karakeep UI.
- **CANDIDATES (test in order):**
  1. relative `![](/api/assets/<assetId>)`  ← preferred (instance-agnostic)
  2. absolute `![](https://keep.grepon.cc/api/assets/<assetId>)`
  3. `/api/v1/assets/<assetId>` variants
- **DECIDE:** the first candidate that renders. If only the absolute form works, `assetInlineUrl` must build from the configured `karakeepUrl` origin (strip `/api/v1`). If a cookie/CSP blocks `![]()` images entirely, STOP — inline isn't viable on this Karakeep version; fall back to "cover only" + document. (This whole feature hinges on Task 0.)
- **VALIDATE:** the user (or a Karakeep UI screenshot) confirms the image renders in the body.

### Task 1 — Pure rewrite helper + tests
- **ACTION:** New `karakeepInline.ts`:
  ```ts
  /** Replace `![alt](../Photos/<file>)` with `![alt](<url>)` for each file present in
   *  the map. Files not in the map (broken links, ../Files/*) are left untouched.
   *  Pure + idempotent. */
  export function rewriteImageLinksToAssets(
    body: string,
    fileNameToUrl: ReadonlyMap<string, string>,
  ): string;
  ```
- **IMPLEMENT:** regex over `!\[([^\]]*)\]\(\.\./Photos/([^)]+)\)`; for each, look up the (decoded) filename in the map; if found, emit `![${alt}](${url})`, else leave the original match. Preserve alt text. Don't touch `../Files/` or `../Audio/`.
- **MIRROR:** `PAIRED_IMAGE_LINK_GRAMMAR`, `IDEMPOTENT_FIELD_REWRITE`.
- **GOTCHA:** filenames can contain spaces/parens — the `[^)]+` capture stops at the first `)`; carnet's slugified filenames avoid `)`, but decode `%20`-style if any. Idempotency: running it on an already-rewritten body (asset URLs, no `../Photos/`) is a no-op.
- **VALIDATE:** unit tests — single image, two images (both swapped), alt text kept, unknown filename untouched, `../Files/` untouched, no-image no-op, double-apply == single-apply.

### Task 2 — `getBookmarkAssets` + `assetInlineUrl` in the client
- **ACTION:** In `karakeep.ts` add a GET helper returning the bookmark's assets, and a URL builder per Task 0's verdict.
  ```ts
  export async function getBookmarkAssets(bookmarkId: string):
    Promise<Array<{ id: string; fileName: string; assetType: string }>>; // GET /api/v1/bookmarks/{id} → json.assets ?? []
  export function assetInlineUrl(assetId: string): string; // Task 0 format
  ```
- **MIRROR:** `KARAKEEP_JSON_READ` — reuse `getKarakeepConfig`/`assertHttpsOrLocal`/`withTimeout`/`KarakeepError`; add a `GET` branch to `karakeepFetch` (currently POST/PATCH only) or a small dedicated GET.
- **GOTCHA:** tolerate a missing/empty `assets` array (return `[]`). `assetInlineUrl` may need the origin from `getKarakeepConfig().url` (strip trailing slash + `/api/v1`).
- **VALIDATE:** `karakeep.test.ts` — mock `fetch` for the GET; assert it parses the assets array and the URL builder output.

### Task 3 — Wire the inline rewrite into the export flow
- **ACTION:** After `pushNoteAttachments` (uploads/attaches assets), inline the body:
  ```ts
  // in karakeepExport.ts (or RecentDetailScreen.runKarakeepExport, after pushNoteAttachments)
  const assets = await getBookmarkAssets(id);                  // server truth: fileName → assetId (covers already-synced images)
  const map = new Map(assets
    .filter(a => /* image, by fileName ext or by being in the note's Photos links */ true)
    .map(a => [a.fileName, assetInlineUrl(a.id)]));
  const inlined = rewriteImageLinksToAssets(noteBody, map);
  if (inlined !== noteBody) await updateTextBookmark(id, { text: inlined, title, createdAt });
  ```
- **DECISION:** whether to also inline the cover image's link (it already shows as `bannerImage`). Default: **inline it too** (the cover card and the body are separate UI regions; showing the lead photo in both is fine and simpler than special-casing). Revisit if it looks redundant in the UI.
- **MIRROR:** the existing create/update + `assetError` handling in `runKarakeepExport`.
- **GOTCHA:** ordering — the body is inlined AFTER assets exist (so the URLs resolve). Uses `getBookmarkAssets` (not the local record) so re-exports inline ALL images, including ones synced on a prior run. Never throw: fold failure into the `assetError` snackbar (the bookmark + cover already succeeded).
- **VALIDATE:** `karakeepExport.test.ts` — mock `getBookmarkAssets` → assert `updateTextBookmark` called with the rewritten body; no-op when no images; error in the inline step surfaces as the soft `assetError`, not a throw.

### Task 4 — Tests (unit)
- Per Tasks 1–3. Keep `MockXHR`/`fetchMock` shapes from `karakeep.test.ts`. Target: the rewrite helper fully covered; the orchestration asserts the second `updateTextBookmark` carries asset URLs.

### Task 5 — On-device + live verification (the real gate)
- **ACTION:** Release build on the Pixel 9 (`ANDROID_SERIAL=4A111FDKD0000C npm run android:release`); export a **fresh** multi-photo note (the incremental record skips already-synced images, so use a new note or one not yet Karakeep-exported).
- **VALIDATE:**
  - [ ] All photos render inline in the Karakeep bookmark body (not just the cover).
  - [ ] Re-export → still correct, no duplicate images, no dup assets.
  - [ ] Confirm via API: `GET /bookmarks/{id}` text contains the asset URLs, not `../Photos/`.
  - [ ] `input -d 0` for taps (Pixel 9 gesture-steal quirk — see memory).

---

## Testing Strategy
### Unit Tests
Full coverage of `rewriteImageLinksToAssets` (Task 1) + the export-orchestration cases (Task 3). Mock `getBookmarkAssets`/`updateTextBookmark`.
### Edge Cases Checklist
- [ ] Note with 0 images → no second `updateTextBookmark` (no-op)
- [ ] Note with 1 image (== the cover) → inlined too (or skipped per Task 3 decision)
- [ ] Image link present in body but asset upload failed earlier → filename not in map → link left as `../Photos/x` (degrades, no crash)
- [ ] `../Files/doc.pdf` link → untouched
- [ ] Re-export an already-inlined bookmark → carnet sends original `../Photos/` body (step 1), re-inlines → same result (idempotent)
- [ ] Filename with spaces / unicode → matched + rewritten (or left if ambiguous)

## Validation Commands
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
cd apps/mobile && ANDROID_SERIAL=4A111FDKD0000C ANDROID_HOME=/home/user/Android/Sdk npm run android:release   # JS-only; release build needed (Hermes)
```

## Acceptance Criteria
- [ ] Task 0 resolved: a confirmed asset URL form renders inline in Karakeep
- [ ] Every image in a multi-photo note appears inline in the exported bookmark body
- [ ] Cover (`bannerImage`) still shows; no duplicate assets; re-export idempotent
- [ ] Vault note unchanged on device
- [ ] Inline-step failure degrades to the soft `assetError` snackbar — never crashes or blocks the export

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Karakeep won't render `![]()` to an asset URL** (CSP / renderer host allow-list) | Medium | Feature not viable on this Karakeep | Task 0 gates the whole plan; if it fails, ship "cover only" + document, revisit on a Karakeep upgrade |
| Asset URL form is instance/version-specific | Medium | Breaks on other Karakeep instances | Prefer the relative `/api/assets/{id}` form; if absolute needed, build from the configured `karakeepUrl` |
| Second `updateTextBookmark` per export (extra PATCH) | Low | Minor latency | One extra call; acceptable. Skip it when the rewrite is a no-op (`inlined === noteBody`) |
| `getBookmarkAssets` adds a round-trip + a new GET path in the client | Low | More client surface | Small; reuses existing hardening |
| Filename collision between a Photos image and a Files entry | Low | Wrong link rewritten | Map only image assets / only rewrite `../Photos/` links |

## Notes
- Builds directly on the `bannerImage` cover (`cdfa53e`) and the XHR crash fix (`2ccf244`). Land those first; this is the "show the rest" follow-up the user asked for.
- The server-truth approach (`getBookmarkAssets`) is deliberately chosen over upgrading the local `karakeepAssetSync` record to a `key→assetId` map — it's simpler, needs no migration, and naturally covers images synced on earlier exports.
- If Task 0 reveals the renderer needs an *absolute* same-origin URL, that's still fine (build from `karakeepUrl`); only a hard CSP block kills the approach.
- Live-instance facts captured 2026-06-14: bookmark `bx90kzvotd2dhoxho8o4yhjr` had 2 `image/jpeg` assets (8.2 MB + 5.9 MB) attached; `bannerImage` renders as the cover; `userUploaded` does not render on a text bookmark. See memory `[[karakeep-multipart-sharedarraybuffer-crash]]`.
