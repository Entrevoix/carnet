# Session handoff — 2026-06-14, bridges a /clear

> Continues from `session-handoff-2026-06-13-pm.md`. Entirely headless feature work — three v2
> slices built, reviewed, and merged. `main` is clean; no open PRs; vitest 554/554, tsc clean.
> No on-device work this session (no device QA was needed or done).

## Shipped this session (all squash-merged to `main`)
- **#53 — STT onboarding v2** (squash `bc014ca`). The proactive half of STT onboarding. #50 built the
  readiness probe (`checkSttReadiness`) but left it as dead code — only the reactive error-sheet button
  was wired. v2 calls the probe to catch the missing English voice model BEFORE dictation dead-ends with
  code 12.
  - New pure core `src/voice/sttOnboarding.ts` (`describeReadiness`, `shouldPromptProactively`, versioned
    one-shot flag `stt_onboarding_prompted_v1`; no RN/expo imports → vitest-tested, mirrors #50's
    `mapReadiness` split).
  - `src/voice/VoiceReadinessBanner.tsx` — one-shot proactive Home banner; marks the flag **on show** (not
    on action) so a remount can't re-nag; inert by design on iOS/Expo Go.
  - `src/voice/VoiceSetupCheck.tsx` — manual **"Check voice setup"** in a new **Settings → Voice input**
    section. +14 tests.
- **#54 — Karakeep re-export in place** (squash `1eb13a2`). v1 re-sent an already-exported note as a NEW
  bookmark (duplicate on server, overwrote `karakeepId`). v2 updates in place.
  - `updateTextBookmark(id, {text,title?,createdAt?})` → `PATCH /api/v1/bookmarks/{id}` (no `type` field;
    tolerates a 204/idless 2xx).
  - Extracted the shared `karakeepSendJson(path, method, body)` helper; URL-encode the bookmark id.
  - `RecentDetailScreen.runKarakeepExport` branches: update when `karakeepId` present, **404 → create
    fallback**, else create. Confirm dialog + snackbar copy updated ("Update" / "Updated in Karakeep").
    +9 tests.
- **#55 — Karakeep asset upload** (squash `042ddf5`). Pushes a note's image/file **attachments** as
  Karakeep assets attached to its text bookmark.
  - `uploadAsset({uri,mime,filename})` → `POST /api/v1/assets` (multipart, **`file`** field, no
    Content-Type so fetch sets the boundary, 60s timeout; accepts `assetId` **or** `id` in the response).
  - `attachAssetToBookmark(id, assetId, assetType="userUploaded")` → `POST /api/v1/bookmarks/{id}/assets`
    with `{id: assetId, assetType}` (body field is **`id`**, not `assetId` — pinned by a test).
  - Generalized the request helper into `karakeepFetch` (shared JSON + multipart hardening).
  - New `src/lib/karakeepExport.ts` `pushNoteAttachments(bookmarkId, noteBody)`: upload+attach per
    non-Audio paired binary; skips broken links; stops at first failure; **never throws**.
  - `RecentDetailScreen` pushes attachments **on first export only** (skip on in-place update). +16 tests.

Process for each: branch → TDD → independent `code-reviewer` APPROVE → fixes applied → green CI
(shared/mobile/desktop/gate) → squash-merge + delete branch. #55 also got a confirmatory second review of
the final committed state.

## Key decisions / rationale (don't re-litigate)
- **Karakeep assets push on CREATE only, skip on update.** Avoids accumulating duplicate assets on every
  re-send (the wart #54 fixed for bookmarks) WITHOUT fragile per-asset frontmatter tracking — frontmatter
  values can't hold newlines and split on commas (unsafe for file paths). See `src/lib/frontmatter.ts`.
- **`assetType: "userUploaded"`** for all attachments — the generic enum slot that accepts images + files.
- **`uploadAsset` accepts `assetId` OR `id`** + guards the JSON parse — fail-safe against response-shape
  variance (the reviewer's single highest-leverage finding).
- **STT banner marks the one-shot flag on show**, so a Home remount can't re-probe and re-nag.
- API shapes for all Karakeep work confirmed against the **official Karakeep OpenAPI spec v1.0.0** (the
  `document-specialist` research pass: `PATCH /bookmarks/{id}`, `POST /assets` field `file`,
  `POST /bookmarks/{id}/assets` field `id`, lists endpoints, no bulk endpoint).

## Open / pending
- **Karakeep remaining v2 slices** (all API-confirmed, none started):
  - **incremental asset sync** — per-asset tracking + retry; closes the "first-export-only" gap (an
    attachment added to / failed on an already-exported note isn't re-pushed). Also fold in: a
    resolve-without-creating-subdir helper (`resolvePairedUri` → `findOrCreateSubdir` can create an empty
    dir on a read-only resolve — pre-existing, benign) and an upload count/size cap + cancel (reviewer
    backlog notes on #55).
  - **bulk export** — Home multi-select → loop the proven v1/v2 client (no batch endpoint exists).
  - **lists** — `GET/POST /lists` (icon required), `PUT /lists/{listId}/bookmarks/{bookmarkId}` (no body, 204).
- **Karakeep live-instance e2e (DEBT, unchanged since v1):** NO end-to-end run against a real Karakeep yet
  (needs an instance URL + API key). Two asset-upload assumptions to confirm on-device — **both FAIL SAFE**
  (feature inert, never crashes/dups/corrupts if wrong): (1) `POST /assets` keys the id as `assetId` (code
  also accepts `id`); (2) `userUploaded` is an accepted attach `assetType`. Then: export a note with an
  image + a PDF → both appear as assets; re-export → no duplicate assets.
- **STT onboarding on-device smoke (DEBT, unchanged since #50):** the `needs-model` banner/download path
  can't be smoke-tested until a device LACKS the en model — both attached Pixels have it, so the banner
  stays hidden and the Settings check reports "ready" (that path IS verifiable on-device).

## State of the tree
- `main` clean, synced with origin. No open PRs. No local branches besides `main`.
- `apps/mobile`: vitest **554/554** (26 files), `tsc --noEmit` clean. Test/typecheck are the only gates
  (no `lint` script; CI runs shared/mobile/desktop/gate).
- Untracked `.reports/codemap-diff.txt` is a stale Jun-11 artifact — ignore (never committed).

## Carry-forward facts (still true; see prior handoff + memory for full detail)
- Pixel test devices are **STOCK Google Android 16** (not GrapheneOS). Build+install:
  `cd apps/mobile && ANDROID_SERIAL=<serial> ANDROID_HOME=/home/user/Android/Sdk npm run android:release`.
  All three slices this session are RN-JS only → no native rebuild / no `editor:build` needed.
- A repo hook blocks shell `find`/`grep`/`cat`/`ls` (use Read + `git grep`/`git ls-files`). The
  `claude-mem` PostToolUse hook noisily errors on diff content — harmless, ignore.
- Full session detail lives in this session's transcript; device serials + QA quirks in the prior handoff.

## Memory pointers
[[active-backlog-2026-06-13]] (updated this session with #54/#55), [[backlog-prp-plans]],
[[pixel-stt-device-recognizer-health]], [[build-env-no-google-maven-fetch]],
[[pixel-fold-on-device-qa-quirks]].
