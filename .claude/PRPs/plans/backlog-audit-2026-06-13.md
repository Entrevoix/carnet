# Backlog audit — 2026-06-13 (overnight handoff)

> Triggered by an overnight push to "move coding forward" across three scoped areas.
> **Finding: all three are already code-complete and merged to `main`.** The plan docs
> below are STALE — they describe shipped work as "next / not started," which is what made
> the backlog look open. What genuinely remains is device-gated or needs product input.

## Scoped areas — actual status (with evidence)

| Scoped item | Status | Evidence |
|---|---|---|
| **WYSIWYG editor-web enhancements** | ✅ Shipped | Paste-markdown + picture insert merged (#42, `67a254d`); large-image inject-then-swap + save hardening merged (#43 → PR #45, squash `8a1c7aa`). The `wysiwyg-editor-web-enhancements.plan.md` item B is done. |
| **Audio + arbitrary file share types** | ✅ Shipped | `ShareReceiveScreen.tsx` save() has the audio branch (lines ~223–283) and other-file branch (~284–330); `app.json:69` already lists `["text/*","image/*","audio/*","*/*"]`; `shareHelpers.ts` extracted + 25 tests. Landed commit `8d3a6fe` ("feat: accept audio + arbitrary file shares into vault"). The whole `audio-and-arbitrary-file-share-types.plan.md` is done. |
| **Package rename → `com.ventoux.carnet`** | ✅ Source edits done | `app.json:12,22` (`bundleIdentifier` + `package`) and `apps/desktop/src-tauri/tauri.conf.json:5` (`identifier`) are all `com.ventoux.carnet`. No `us.beary.carnet` left outside one historical report doc. |

## Stale plan docs (describe already-shipped work)
- `wysiwyg-editor-web-enhancements.plan.md` — "picture insert (NEXT — not started)" → shipped (#42/#43).
- `audio-and-arbitrary-file-share-types.plan.md` — "mostly a manifest change + two new branches" → all done.
- `rename-app-package-com-ventoux-carnet.plan.md` — source edits done; only the device-gated native verify remains.
- (Already accurate: `wysiwyg-location-tags.plan.md`, `rich-text-wysiwyg-editor.plan.md`, `stt-flush-on-external-interaction.plan.md` are tracked as merged in memory.)

These should be moved to `.claude/PRPs/plans/completed/` (deferred here to avoid disturbing any concurrently-running session).

## What GENUINELY remains — none is safe for an unattended headless loop

### Device-gated (need the Pixel + the user's PIN — a headless loop cannot do these)
- ~~**#43 on-device smoke**~~ — ✅ **PASSED 2026-06-13** (Pixel 9 Pro Fold): large baseball photo (over the old 8 MB cap) previews in-editor via inject-then-swap under Vanadium, both images render (no blank), Save round-trips to canonical `../Photos/` links (Attachments card resolves them, no blob). See `wysiwyg-large-image-inject-then-swap-handoff.md`.
- **Share types** — confirm carnet appears in the Android share sheet for `audio/*` and `*/*`, and the binary lands in `Audio/` / `Files/`. Needs `expo prebuild` + a native rebuild + on-device share.
- **Package rename** — `rm -rf android && expo prebuild` + `npm run android:release` installs `com.ventoux.carnet` as a NEW app alongside the old `us.beary.carnet` (different package = no in-place update, no shared data). Verify native modules (STT, capture notification, widget, app shortcuts) under the new id, then uninstall the old app. **Risk: a native rebuild may need uncached Google-Maven deps the build env can't fetch ([[build-env-no-google-maven-fetch]]).**
- STT device-side: download the on-device speech model + speak-test ([[pixel-stt-device-recognizer-health]]).

### Needs product input (not safe to guess overnight)
- **rich-content-attachments Phase 2 — Karakeep export** (marked "NOT built" in memory). Needs the Karakeep endpoint/format decisions.

### Editor loose ends (thin / risky)
- **MEDIUM-4 editor-ready ack** — substantially subsumed by #43's `content-ack` (the blind injection staircase now stops on a real ack). Re-confirm on-device; little code left.
- **LOW-4 CSP `<meta>`** in `editor-web/index.html` — a wrong CSP can block the bundle's own module script; review said "not required now"; only with on-device care.

## Recommendation
There is **no safe, scoped, headless feature work left** to loop on. Best next moves, in order:
1. **On-device verification pass** (user + Pixel): #43 smoke, share-sheet receipt, and the new-package launch — these close the three shipped features for real.
2. If you want headless loop work: point it at **Karakeep Phase 2** (after you supply the endpoint/decisions) or a **test-coverage / hardening pass** on the pure `src/lib/*` modules (TDD, green CI, review-before-merge) — but that's quality work, not the scoped features (which are done).
3. Move the stale plans to `completed/` (housekeeping).
