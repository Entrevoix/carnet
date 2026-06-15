# Session handoff — 2026-06-14 (PM), inline images shipped

> Continues from `session-handoff-2026-06-14.md`. One feature, both halves, built → reviewed →
> **live-verified** → squash-merged. First session to run a real **live Karakeep e2e** (against
> `keep.grepon.cc`). `main` clean; vitest 600/600, tsc clean; CI green.

## Shipped this session (squash-merged to `main`)
- **#60 — inline images** (squash `eb6f043`). Images render INLINE in the note text — in Carnet's
  read-only detail view AND in the exported Karakeep bookmark body — instead of a separate "Attachments"
  card (Carnet) / hidden side-assets (Karakeep). On-disk `.md` UNCHANGED: keeps `![](../Photos/x.jpg)`
  relative links (no base64 — issue #43).
  - **Part A — Carnet render.** `stripPairedBinaryLinks(body, {keepImages:true})` leaves Photos embeds in
    the prose (still strips Audio→player, Files→rows). New custom react-native-markdown-display `image`
    rule in `src/components/markdownImageRule.tsx`, backed by pure, unit-tested
    `src/components/inlineImageSrc.ts` (`classifyImageSrc`: local/external/hidden) — resolves each embed to
    a device URI via the existing resolved-attachments map and renders `<Image>` in place; broken links
    render nothing. Attachments card is now files-only. Handles markdown-it's percent-encoded `src` (decode
    fallback for non-ASCII names) + reads alt text from `node.content`.
  - **Part B — Karakeep inline body.** After uploading assets, rewrite the bookmark body's `../Photos`
    embeds → `/api/assets/{id}` (`src/lib/karakeepInlineImages.ts`, pure) and PATCH the text. New
    `assetContentPath(assetId)` in `karakeep.ts` (RELATIVE url — rides the web session cookie). Vault note
    keeps relative links; only the Karakeep copy is inlined. First image still the `bannerImage` cover.
  - **Asset-sync schema migration.** `karakeepAssetSync` record went `Set<key>` → `Map<key, assetId>` so a
    re-export rebuilds asset URLs WITHOUT re-uploading. Legacy v1 array records auto-migrate (key → `""`,
    re-uploaded once to capture the assetId). `pushNoteAttachments` now returns `{error, imageUrlByRel}`.
    +tests across writer / karakeep / karakeepAssetSync / karakeepExport / inlineImageSrc /
    karakeepInlineImages.

Process: branch `feat/inline-images` → TDD → `code-reviewer` on Part A (2 MEDIUMs fixed, no CRIT/HIGH) →
**live Karakeep e2e** → green CI (shared/mobile/desktop/gate) → squash-merge + delete branch.

## Key decisions / rationale (don't re-litigate)
- **Option 1: keep relative links on disk, render/rewrite for display — NOT base64-in-md.** Base64 in a
  synced `.md` was explicitly rejected (issue #43: multi-MB notes, editor-blanking, sync bloat). The `.md`
  is untouched; only the RENDER (Carnet) and the EXPORTED COPY (Karakeep) inline the image.
- **Karakeep asset URL = relative `/api/assets/{id}`.** Verified live: serves 200; Karakeep's
  `MarkdownReadonly` (the `BookmarkMarkdownComponent` renderer for a text bookmark's `content.text`)
  renders `![](…)` images UNRESTRICTED — no sanitize / allowedElements / custom-img / url-transform. A
  relative URL rides the viewer's web session cookie. See [[karakeep-inline-image-render]].
- **Asset-sync stores assetId (Set→Map).** Needed so re-exports keep images inlined without re-uploading.
  Upgrade cost: previously-exported notes re-upload their images ONCE (legacy records lack assetIds) —
  bounded, never corrupting (matches the documented fail-open behavior).
- **Inline PATCH is best-effort** — the bookmark already holds the original text + attached assets (incl.
  the cover), so a failed inline PATCH never loses the export.

## Open / pending
- **Carnet app-side inline render — NOT verified on-device.** The Karakeep half is visually confirmed (a
  live demo bookmark rendered the image in-body). Carnet's own RN render couldn't run headless. Next device
  session: open a note that has a photo → the image should appear IN the body, not in a separate card.
- **Karakeep live-instance e2e debt — PARTIALLY closed.** First real run happened this session
  (`keep.grepon.cc`): asset upload + `/api/assets/{id}` serve + inline render all confirmed. Still not
  exercised on a real device through the actual app UI (only via API scripts + the merged unit tests). The
  #55 asset-upload assumptions (assetId-or-id, userUploaded) are now also live-confirmed.
- **Karakeep remaining v2 slices (unchanged, none started):** bulk export (Home multi-select → loop the
  proven client, no batch endpoint); lists (`GET/POST /lists`, `PUT /lists/{listId}/bookmarks/{bookmarkId}`);
  upload count/size cap + cancel (reviewer backlog from #55).
- **STT onboarding on-device smoke (DEBT, unchanged):** needs a device LACKING the en model; both Pixels
  have it, so the banner stays hidden / Settings check reports "ready".

## State of the tree
- `main` clean, synced with origin (includes the #60 merge). No open PRs. No local branches besides `main`.
- `apps/mobile`: vitest **600/600** (29 files), `tsc --noEmit` clean. CI gates: shared/mobile/desktop/gate
  (all green on #60). Test/typecheck are the only gates (no `lint` script).
- Untracked `.reports/codemap-diff.txt` — still the stale scan artifact; left out of every commit. Ignore
  or gitignore `.reports/`.

## Carry-forward facts
- **Live Karakeep instance is now known:** `https://keep.grepon.cc` (jd's). The API key was provided
  in-chat this session and used transiently (never written to a file); **user declined to rotate — don't
  raise it again.** A demo bookmark (`/dashboard/preview/nhwh1qzguwx058zb59wameb7`) was left for the
  eyeball check; safe to delete.
- Pixel test devices are **STOCK Google Android 16** (not GrapheneOS). Build+install:
  `cd apps/mobile && ANDROID_SERIAL=<serial> ANDROID_HOME=/home/user/Android/Sdk npm run android:release`.
  #60 is RN-JS only → no native rebuild / no `editor:build` needed.
- A repo hook blocks shell `find`/`grep`/`cat`/`ls`/`head`/`tail`/`sed`/`awk` (use Read + `git grep`/
  `git ls-files`). The `claude-mem` PostToolUse hook noisily errors on diff content — harmless, ignore.

## Memory pointers
[[inline-images-shipped]], [[karakeep-inline-image-render]] (both new this session),
[[active-backlog-2026-06-13]], [[karakeep-multipart-sharedarraybuffer-crash]], [[backlog-prp-plans]],
[[pixel-stt-device-recognizer-health]], [[build-env-no-google-maven-fetch]].
