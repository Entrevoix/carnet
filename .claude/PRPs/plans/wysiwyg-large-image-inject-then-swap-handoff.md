# Handoff: WYSIWYG large-image preview (inject-then-swap) + save hardening — issue #43

> Status as of 2026-06-12. Branch `feat/wysiwyg-large-image-preview` → PR (off `main` @ `3022f26`).
> **tsc clean, vitest 488/488, editor bundle rebuilt, independent opus review passed (one MAJOR
> found + fixed).** ⛔ **On-device smoke NOT yet done — it is the gating acceptance criterion and is
> device-only.** This doc bridges a `/clear` and hands off to an overnight loop.

## What shipped (code-complete, behind on-device verification)
Closes both items of issue #43. Follows directly from #42 (picture insert, merged `67a254d`).

### Item 1 — preview large images via inject-then-swap
The old design folded EVERY image's `data:` URI into ONE `setMarkdown` string. On-device a ~10 MB+
payload silently failed to apply → editor opened BLANK → a Save then blanked the note. Reverted the
naive cap-raise (`eeed1cf`); the fix is architectural, not a bigger constant.

Now:
1. Inject the body with **canonical** `../Photos/` links first — a small, reliable `setMarkdown`.
2. Wait for the editor's **content-ack** (proof it applied), then swap each image to its `data:` URI
   via its **own** bounded `set-image-src {rel, dataUri}` bridge message, one image per round-trip.
3. Web side finds the image node by `src === rel` (the canonical src just injected) or `title === rel`
   (idempotent re-swap) and sets `src = dataUri, title = rel` via a ProseMirror `setNodeMarkup`
   transaction — display src updated, canonical path kept in the title for serialization.

An image whose swap never lands (resolver null, message dropped/oversized) **stays canonical**: it
shows broken in-editor but saves + renders fine. No single message carries the whole note's base64, so
the blank-editor failure is gone. `MAX_EDITOR_IMAGE_BASE64` raised 8 → 16 MB — it now bounds ONE
per-image message, not the compound body, and a too-large swap degrades gracefully. **Tune on-device.**

### Item 2 — harden save against a silently-empty editor
- The web side echoes a `content-ack` carrying the **applied body length** after `setContent`.
  `bodyInjectedRef` flips only on that ack (the original #43 failure = the oversized message never
  reaching the WebView → no ack → `getMarkdown()` refuses → note can't be blanked).
- **Confirmation is gated on `len > 0`** (review fix): a zero-length ack means `setContent` reduced the
  body to empty — treated as *unconfirmed* so the guard still bites. (Was a MAJOR review finding: the
  length was sent but ignored, leaving a narrow confirmed-but-empty blanking path. Now closed.)
- Pure `isSuspiciousBlanking({original, result, acked})` in `getMarkdown()`: refuses to return an empty
  body for a non-empty note when the load was never confirmed → surfaces a Save error banner, never
  writes. An ack-confirmed empty result is a genuine user clear and is allowed (accepted tradeoff per
  the issue: a legitimate full-clear during the rare no-ack fallback is refused — error banner, no data loss).

## Files
- `src/lib/editorImages.ts` — removed `resolveImagesForEditor` (the old fold-into-body path); added
  `photoEmbedRels()` (images to swap, deduped, title-carried embeds skipped) and `isSuspiciousBlanking()`;
  raised the cap to 16 MB with a rewritten comment. Kept `restoreImagesFromEditor` (save path) + the
  base64-never-on-disk postcondition catch-all.
- `src/bridges/MarkdownBridge.ts` — new `set-image-src` + `content-ack` messages; `swapImageSrc()`
  (the `setNodeMarkup` transaction); RN `setImageSrc()` method; `content-ack` routing. **Editor-web
  change → drove the bundle rebuild.**
- `src/bridges/markdownAck.ts` (NEW, pure) — single-slot `onceContentAck`/`resolveContentAck` registry,
  mirrors `markdownResponse.ts`. + `markdownAck.test.ts` (5 tests).
- `src/components/WysiwygEditor.tsx` — rewired injection: ack-gated staircase `setMarkdown` (re-send
  guarded by `postInjectRef` so it can never clobber a swap), then sequential `runSwaps`; `getMarkdown`
  blanking guard; unmount disposes the ack slot + timers.
- `src/lib/editorImages.test.ts` — dropped the removed `resolveImagesForEditor` block; added
  `photoEmbedRels` + `isSuspiciousBlanking` + inject-then-swap round-trip tests (23 total).
- `editor-web/generated/editorHtml.js` — rebaked by `npm run editor:build` (carries the bridge change).

## Verified WITHOUT the device
- `npx tsc --noEmit` clean (the ONLY CI gate for mobile — CI does not run mobile vitest).
- `npm test` 488/488 (was 482; +6 net).
- `npm run editor:build` succeeds; bundle re-baked (contains `content-ack`, `set-image-src`, `setNodeMarkup`).
- Independent opus review: **race-safety proven** — RN never *sends* a `setMarkdown` after the first
  swap (`finishInjection` sets `postInjectRef`, `clearInjectTimers`, then `runSwaps`; the FIFO RN→WebView
  channel applies all `setMarkdown`s before any swap). `setNodeMarkup` multi-node position validity (image
  is a leaf → size-stable), no double-dispatch, and verbatim `src` storage were refuted as risks with
  throwaway tests against the real tiptap pipeline. One MAJOR (ack length ignored) was found and FIXED.

## ⛔ On-device smoke — THE gating unknowns (need the Pixel, ~10 min)
Build + install: `cd apps/mobile && ANDROID_SERIAL=4A111FDKD0000C ANDROID_HOME=/home/user/Android/Sdk npm run android:release`
(RN+editor-web change → the rebuilt bundle is already committed; just build the APK.)

1. **Large image previews in-editor.** Open a note with a `![](../Photos/x.jpg)` image OVER the old
   8 MB cap (e.g. the "Jack's Baseball Team" QA note's big photo, which did NOT preview under #42) →
   Edit → it now renders inline (the swap landed). Confirms `src === rel` node-match works under
   @tiptap/markdown's verbatim href storage (the one assumption that's device-confirmable only).
2. **Save → canonical link, NO blob.** Save → reopen → image shows in the read-only Attachments card
   (resolves `../Photos/...`), body is clean prose, no base64. (Vault is the private sandbox — verify
   via the in-app render, not raw bytes.)
3. **No-churn round-trip.** Open an image note, Save WITHOUT editing → `.md` byte-unchanged
   (`next === body` short-circuit holds).
4. **Forced empty-editor cannot blank a note** (Item 2). Hard to trigger now that the body is small; if
   you can wedge injection, Save must show the error banner, NOT write an empty body.
5. **Multiple images** (3+) in one note all preview (the compound-payload case the old design broke on).

If #1 fails (data URI / node-match won't work under Vanadium), the documented fallback is a `file://`
src with `allowingReadAccessToURL`. Prove #1 first.

## Known/accepted limitations
- A pre-existing Photos embed that already carries a markdown **title** (user caption) is left canonical
  (no preview) — the title slot is how we round-trip the canonical path; we won't clobber a real caption.
- A single image larger than the actual RN↔WebView message limit won't preview (swap message dropped) —
  but degrades gracefully (canonical, editor not blank, save safe). The 16 MB cap is a guess; tune on-device.
- During the rare no-ack fallback, a genuine full-clear of a note is refused (error banner) — accepted
  per the issue ("never write" beats "might blank").

## Memory pointers
[[backlog-prp-plans]], [[build-env-no-google-maven-fetch]], [[pixel-fold-on-device-qa-quirks]],
[[appendjournal-strips-entry-frontmatter]].
