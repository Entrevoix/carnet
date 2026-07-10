# Stage 2 plan — backend generalization + capture-surface follow-through

**Status:** ready for execution (Opus / Claude Code, one branch at a time) · **Date:** 2026-07-04
**Inputs:** `AUDIT-backend.md` (root), `capture-timing.decision.md`, `security-trust-boundaries-2026-07-04.md`, `v0.5-browse-search.prd.md`, `on-device-backend.prd.md`.
**Constraints (verified, non-negotiable):** vitest + `tsc --noEmit` are the only CI gates (no lint script) — every branch keeps 600/600 green and adds tests. No SQLite (expo-sqlite@55 ABI-broken on SDK 54, `queue.ts:16`). Frontmatter conventions in `AUDIT-backend.md §1.5` must stay byte-compatible. Attribution disabled in commits. Branch from `main`, one PR per branch, TDD.

## Framing

The backend generalization this stage was originally scoped around **already shipped in v0.2** (navetted/claude-CLI retired; text + vision already unified on one OmniRoute `/v1/chat/completions` endpoint — see AUDIT-backend.md §1.1). So Stage 2 is not a re-architecture; it's closing the real gaps the audit found and adding the two follow-through features. Branches are ordered by dependency: the security/correctness fixes (B1–B3) are prerequisites for the feature work (B4–B7).

## Dependency graph

```
B1 model-split ──┬─► B2 ocr-fold-in
                 └─► B7 on-device-backend (prereq: vision must be routable)
B3 sanitize+normalize (independent, ship early — gates dogfooding)
B0 net-hardening (independent, tiny)
B4 capture-timing ──► B5 notification-inline-reply
B6 browse-search (independent axis)
```

Recommended merge order: **B3 → B0 → B1 → B2 → B4 → B5 → B6 → B7.** B3 first because it gates non-developer dogfooding; B7 last (largest, native, depends on B1).

---

## B0 — network-control hardening (Security M2 + M3)

**Why:** two existing controls are bypassable; both are small, self-contained, high-confidence fixes.
**Changes:**
- `omniroute.ts:181` + `karakeep.ts:105`: replace the prefix regex `/^http:\/\/(localhost|127\.0\.0\.1|10\.)/i` with `new URL()` host parsing — exact `=== "localhost"`, `=== "127.0.0.1"`, numeric `10.0.0.0/8` check. (M3)
- `urlpreview.ts:192,225`: `redirect: "manual"`, re-run `isBlockedHost` on each hop's `Location` before following; validate the final host before reading the body. (M2)
**Tests:** `http://10.evil.com` / `localhost.attacker.com` / `127.0.0.1.attacker.com` rejected; genuine `10.x`/localhost dev URLs still allowed; redirect-to-`169.254.169.254` blocked; redirect-to-loopback blocked.
**Risk:** low. **Watch:** don't break legitimate localhost dev against a local proxy.

## B3 — sanitize LLM markdown + frontmatter normalizer (Security H1 + AUDIT §1.5)

**Why:** THE dogfooding gate. Unsanitized model output is written to a vault that is a code-execution surface in Obsidian (Dataview `dataviewjs`, raw HTML, `javascript:` links). Same code path also fixes L6 (external-image beaconing) and delivers the schema-stability normalizer.
**Design decision to make first — neutralize, don't delete.** The main RCE vectors are covered below, but the approach must not destroy legitimate content or regress a shipped feature (critic findings):
- **Neutralize in place, do not delete.** A knowledge vault legitimately holds ` ```js `/` ```html ` code snippets a user captured on purpose. **Deleting** those blocks is silent data loss the golden-sample tests (which exercise the LLM's happy-path output) will not catch. Prefer rendering-inert over removal: rename an executable fence language to a non-executing one (` ```dataviewjs ` → ` ```text ` or an escaped variant), escape rather than strip raw HTML. The only thing that must be truly removed/rewritten is genuinely executable-on-render markup (`<script>`/`<iframe>`/`on*=`, `javascript:` targets).
- **Cover the full Obsidian surface, not just Dataview.** Also neutralize Templater `<%…%>` (executes JS, popular) and inline `dataview`/DQL blocks — not only ` ```dataviewjs `. Do not claim completeness; document what's covered.
- **Do not regress #60 inline images.** The shipped inline-image feature renders `data:` and `http(s):` image `src` (`inlineImageSrc.ts:40`). A blunt `data:`-stripping pass would break it. Scope link-target rewriting to non-image link contexts, or allowlist image `data:`/`http(s):` src — verify against `inlineImageSrc.ts` before shipping.
**Changes:** new `lib/enrichSanitize.ts`, applied in `omniroute.ts` before returning `markdown` (covers every mode at once), implementing the neutralize policy above.
- **Normalizer:** parse frontmatter, assert the required key set per note type (verified against prompts.ts: idea `created/status/tags` `prompts.ts:46-48`, journal `date/tags/people` `:75-78`, person `name`+contact `:105-113`, shared `kind` `:157,220`), re-serialize in canonical order. On parse failure or missing required keys → treat as enrichment failure so the caller falls into its existing degraded path (stub+banner for photo/share; queue/keep-raw for text) rather than writing a malformed note.
- Preserve byte-exact conventions: `location: lat,lon`, `[[Name]]` wikilinks, journal `## HH:MM` + separators, `karakeepId`.
**Tests:** injected dataviewjs/Templater/script/js-link neutralized; a legit user-authored ` ```js ` snippet SURVIVES (explicit false-positive test, not just happy-path golden samples); a note with a `data:` inline image still renders (no #60 regression); valid notes pass byte-for-byte per mode; malformed frontmatter → degraded path, no file written; the AUDIT-backend.md must-not-drift list asserted per mode.
**Risk:** medium — over-aggressive handling could damage legit notes or break #60. The neutralize-not-delete policy + the false-positive and #60-regression tests are the guard.

## B1 — per-task model split (`chatModel` / `visionModel`) (AUDIT §1.4)

**Why:** one `omniRouteModel` serves text and vision today; nothing guarantees image parts reach a vision-capable model, and a silent drop yields confidently-wrong "enrichment" with no banner. **Hard prerequisite for B7** (a text-only local backend must never silently eat image parts). **Soft prerequisite for B2** — B2 could call `enrichSharedImage` with the single existing model, but B1 is what makes it *correct* (routes card images to a vision model); ship B1 first, but it's not strictly blocking B2.
**Changes:**
- `settings.ts`: add `omniRouteVisionModel` to `Settings`/`PersistedSettings` (non-secret; default a known vision-capable model). Keep `omniRouteModel` as the chat/text model. Backward-compat via the existing `{...DEFAULT_PERSISTED, ...parsed}` spread. Retire or repurpose the vestigial `omniRouteTranscriptionModel` (transcription is on-device — AUDIT-backend.md §1.6.5; coordinate with the `TODO.md:24` Whisper-consolidation decision — Open Question 6).
- `omniroute.ts`: `enrichSharedImage` (and any image-bearing `enrichSharedLink`) uses `visionModel`; text paths use `chatModel`.
- Settings UI: second model picker (reuse the `listModels` picker at `SettingsScreen.tsx:135`).
- Optional (folds in `TODO.md:32`): a "test connection" that verifies the configured vision model is served.
**Tests:** vision calls request `visionModel`; text calls request `chatModel`; missing vision model → notConfigured → degraded path; old settings blob defaults cleanly.
**Risk:** low-medium. **Decision to confirm:** keep model selection explicit per task (recommended) vs. rely on server-side OmniRoute routing (AUDIT-backend.md Open Question 3).

## B2 — fold business-card OCR into chat vision (AUDIT §1.6.2)

**Why:** the bespoke `POST /ocr` endpoint (`ocr.ts:14-37`) is the last non-OpenAI-compatible path and a second invisible server-side model commitment. Folding it into `enrichSharedImage`-style `image_url` chat calls (using B1's `visionModel`) removes it.
**Gate:** **conditional on a quality check** — VLM OCR on real business cards must match the dedicated endpoint (AUDIT-backend.md Open Question 4). Do the side-by-side on-device first; if the VLM underperforms on real cards, keep `/ocr` and close the branch as "evaluated, deferred."
**Changes (if it passes):** `CardScannerModal.tsx:42` calls a vision path instead of `ocrBusinessCard`; retire `ocr.ts`; person enrichment still runs text-only on the extracted text (or one-shot card→PersonNote — decide in plan).
**Tests:** card image → structured contact text; failure → existing person degraded path.
**Risk:** medium (quality-dependent) — hence the explicit gate.

## B4 — capture timing: save-first for Idea/Journal (`capture-timing.decision.md`)

**Why:** removes the blocking LLM call from the two speed-critical modes and unblocks B5. Person keeps enrich-then-preview. **Read the decision memo's corrected Facts/Mechanics before coding — two of the original mitigations were fictional and the branch is bigger than first stated** (critic-confirmed).
**Scope reality (corrected):** this is a UX-policy change **plus net-new conflict-detection code** — there is no existing mtime guard to reuse (the promote-idea race is itself unbuilt, `TODO.md:33`; only existence checks exist, `writer.ts:180,194,207`). And there is no block-scoped journal rewrite primitive; `## HH:MM` is not unique; block-scoping does nothing for Syncthing (whole-file replication). Cost B4 as a real feature, not a toggle.
**Changes:**
- **Build the mtime conflict guard** (step 1 of the memo): record `modificationTime` at raw write, re-check before enriched overwrite, keep-user-version + banner on change. Closes the promote-idea race too.
- **Idea (low-risk):** write a fresh unique-slug file on Save with client frontmatter + `status: pending-enrich`; slug from raw text; on enrichment **update in place, do not rename** to the enriched title (rename = delete+create = Syncthing churn + collision handling).
- **Journal (needs real design — see memo):** do **not** assume a block rewrite. Start with the deferred-write model (Journal stays near-blocking, save-first only for Idea) unless Journal inline-reply is explicitly wanted, in which case use a unique per-block capture-id marker (not `## HH:MM`) for the targeted rewrite. Note this means B5 inline-reply may cover Idea only in v1.
- `Settings.previewBeforeSave` (default **off**) restores the old flow. Person ignores it.
- Reuse the shipped stub+banner + retro-enrich machinery (`PhotoCaptureScreen.tsx:150-248`; `recents-retro-enrich`).
**Tests:** raw Idea note lands before enrichment; in-place enriched update preserves user tags/location and keeps the same filename; mtime-conflict keeps the user's version + banner (no clobber); `previewBeforeSave=on` reproduces old flow; Person unaffected; if Journal targeted-rewrite is built, sibling blocks stay byte-identical and same-minute captures don't collide.
**Risk:** medium-high — the conflict handling is net-new and the Journal path is the sharp edge; concurrent cross-device edits resolve to Syncthing `*.sync-conflict-*.md` (recoverable, not loss) rather than being fully prevented. **Decision to confirm:** flip default to save-first (recommended) vs. opt-in (AUDIT-backend.md Open Question 5); Journal deferred-write vs. true save-first.

## B5 — notification inline reply (RemoteInput) (AUDIT §2.2)

**Why:** zero-app-open text capture — the biggest fewest-clicks win the audit found. Hard-depends on B4 (needs save-first; the notification action can't block on the LLM).
**Changes:** extend `withCaptureNotification.js` with a RemoteInput "quick idea" action; the Kotlin handler writes an Idea via the save-first path and fires async enrichment. Keeps `FLAG_IMMUTABLE` + `setPackage` (verified-sound pattern).
**Tests:** RemoteInput text → Idea on disk without opening the app; enrichment runs async; empty input no-ops.
**Risk:** medium — native + headless-write path; validate on the Pixel test devices (stock Android 16).

## B6 — vault browse + search, Phase 1 (`v0.5-browse-search.prd.md`)

**Why:** retrieval is the biggest capability gap; independent axis, ship anytime.
**Changes (Phase 1 only):** generalize the tag-index pattern into a note-metadata index (`carnet:noteindex:v1`, AsyncStorage — **not** SQLite), folding in the tag index; new Search screen off the HomeScreen header; results via `synthesizeEntry` → RecentDetail. Reuse `listNoteFiles`/`readNote` (concurrency 8) + pure `frontmatter.ts` helpers + `deriveTitle`. Phases 2 (on-demand full-text) and 3 (retrospective query) are separate later plans.
**Tests:** index build/refresh/invalidate parity with tag index; ranking (title→tags→excerpt); result nav opens the right note; incremental upsert on capture avoids full rescan.
**Risk:** medium — SAF scan cost on large vaults (same exposure the tag index already carries).

## B7 — pluggable on-device backend, Phase 1 (`on-device-backend.prd.md`)

**Why:** offline/zero-cost enrichment; the interface was built for it. **Hard prereq: B1** (vision must be routable so a text-only local backend never silently eats image parts).
**Changes (Phase 1 — interface refactor only, no native code):** extract `dispatcher.ts` re-exporting the six enrich fns from the selected backend; point `queue.ts` + capture screens at the dispatcher instead of `./omniroute`; add `Settings.llmBackend` (default `"omniroute"`, only that backend wired). Native module + model download (Phases 2-4) are separate plans — do the `withAudioDecoder`-style spike (first-token latency/memory on Pixels) before committing.
**Tests:** dispatcher routes online + drain paths identically; error predicates (`isPermanentError`/`isNotConfiguredError`) preserved through the dispatcher; old settings default to omniroute.
**Risk:** Phase 1 low (pure refactor); Phases 2-4 high (first native `.so`/ABI/`largeHeap`, 1.5 GB model delivery) — gated behind a spike.

---

## Cross-cutting housekeeping (fold into whichever branch touches the file)

- Retire `navetted`-named desktop keychain commands (`apps/desktop/src-tauri/src/lib.rs:20`) and the "OmniRoute / navetted" line in `docs/CODEMAPS/architecture.md` (AUDIT-backend.md §1.6.5).
- The remaining `navetted` surface is a migration path, **not** dead code — a `navettedUrl?` field (`settings.ts:86`) and a live legacy-migration banner (`SettingsScreen.tsx:397`). Leave the migration UX intact; only remove it once you're confident no device still holds a legacy token/URL to migrate. Fold the decision into this sweep rather than deleting blindly.
- Fix the stale `RecentDetailScreen.tsx:4-10` "read-only this iteration" header (edit mode is shipped).
- `gitignore` the untracked `.reports/` scan artifact (noted across session handoffs).

## Open decisions to resolve before starting (from AUDIT-backend.md)

Carry these into execution; several gate branch shape:
1. OmniRoute transport (HTTPS hostname vs LAN) — informs B0/M3 messaging.
2. Cost tolerance — gates whether B7 is a priority or a someday.
3. Vision policy client-side vs server-side — gates B1 scope.
4. `/ocr` quality bar — gates B2 (build vs defer).
5. Save-first default vs opt-in — gates B4 default + B5 viability.
6. Vestigial transcription setting — gates B1 cleanup.
7. Quick Settings tile — not in this plan (notification covers it); revisit if the notification proves dismissible.
