# Carnet — Backend Generalization + Capture Surface Audit

**Date:** 2026-07-04 · **Scope:** audit/design only, no code changes · **Method:** read of the actual v0.2 codebase (two parallel exploration passes: enrichment backend, capture surface), cross-checked against `docs/CODEMAPS/`, `README.md`, `TODO.md`. All file references are current as of commit `1794adb`.

---

## Section 1 — Backend Generalization Audit

### 1.1 Current state, verified against the repo

**The prior hypothesis is stale. The generalization this audit was scoped to design already shipped in v0.2.** There is no navetted daemon, no WebSocket transport, and no `claude` CLI subprocess anywhere in the live code. Sync is Syncthing (peer-to-peer), not Remotely Save.

Verified architecture today:

```
TEXT  (idea / journal / person / promote-idea / shared-link)
  app → lib/omniroute.ts → HTTPS POST {omniRouteUrl}/v1/chat/completions
        OpenAI-compatible, stream:false, Bearer key, model = omniRouteModel setting

VISION  (photo capture, shared/inline images — #60)
  app → enrichSharedImage → SAME /v1/chat/completions endpoint,
        multimodal content with image_url data: URL parts (OpenAI vision shape)
        — NOT Gemini-native API

OCR  (business cards — the one remaining bespoke path)
  CardScannerModal → lib/ocr.ts → POST {omniRouteUrl}/ocr   custom {image_b64}→{text}
  → resulting text → enrichPerson → /v1/chat/completions (text-only)

AUDIO  transcription: on-device (expo-speech-recognition / Google on-device
  recognizer). No network call. Whisper path retired (vestigial keys remain
  in VoiceButton.tsx:41-44; transcription-model setting is vestigial).

SYNC  writer.ts → local capture folder → Syncthing p2p → workstation Obsidian vault
```

Per-capture-type call chains (citations):

| Capture | Chain |
|---|---|
| Idea | `enrichIdea` (`omniroute.ts:424`) → `buildIdeaPrompt` (`prompts.ts:34`) → `writer.writeIdea` → `Ideas/{slug}.md` |
| Journal | `enrichJournal` (`omniroute.ts:436`) → `buildJournalPrompt` (`prompts.ts:58`) → `appendJournal` → `Journal/YYYY-MM-DD.md` |
| Person | `ocrBusinessCard` (`ocr.ts:14-37`, called from `CardScannerModal.tsx:42`) → `enrichPerson` (`omniroute.ts:454`) → `People/{First}-{Last}.md` |
| Photo | `enrichSharedImage` (`omniroute.ts:479-514`; image part built `:502-511`, 8 MB cap `:136-160`) → `Photos/{slug}.jpg` + paired Idea note |
| Share (image / link / text) | `enrichSharedImage` / `enrichSharedLink` (`omniroute.ts:529`) from `ShareReceiveScreen` |
| Audio | no enrichment at save; `autoTranscribeIfEnabled` (`omniroute.ts:629-659`) inserts `## Transcript` asynchronously, on-device |

All chat traffic funnels through one `executeChat` (`omniroute.ts:258-312`). `stream:false` (`:268`) is load-bearing: the proxy defaults to SSE and RN's fetch hangs on `response.json()` otherwise.

**Config surface** — everything comes from the in-app Settings screen, nothing hardcoded, nothing from env: `omniRouteUrl`, `omniRouteModel` (default `openrouter/openai/gpt-4o-mini`), vestigial `omniRouteTranscriptionModel`, capture folder, prompt overrides in AsyncStorage (`settings.ts:154-167`); API keys in the OS keystore via `expo-secure-store` (`settings.ts:189-192`). The literal `192.168.1.20:20128` appears **nowhere in the repo** — that is a runtime Settings value on the device, not code. 20 s hard timeout, Bearer redaction in errors, HTTPS enforced except `localhost`/`127.*`/`10.*` (`omniroute.ts:179-186`).

**Drift from the prior hypothesis:**

| Prior | Reality |
|---|---|
| Text → navetted (Rust, WS) → claude CLI | Retired entirely in v0.2. Text → OmniRoute `/v1/chat/completions` over HTTPS. |
| Vision → OmniRoute → Gemini natively | OpenAI-compatible chat with `image_url` parts; whatever model the single `omniRouteModel` setting names. |
| Card OCR = the vision path | Distinct bespoke `POST /ocr` endpoint, separate from chat vision. |
| Sync via Remotely Save | Syncthing. |
| Endpoint hardcoded in app | Fully Settings-driven. |
| Live navetted remnants | Dead only: desktop Tauri keychain commands still named `get/set/delete_navetted_token` (`apps/desktop/src-tauri/src/lib.rs:20`), migration/purge code in `settings.ts:175-184`. Desktop is a placeholder stub (fate deferred to v0.3). |

Stale docs worth noting (doc-only, not behavior): `docs/CODEMAPS/architecture.md` still says "OmniRoute / navetted"; `RecentDetailScreen.tsx:4-10` header claims "read-only this iteration" but full edit mode is shipped.

### 1.2 Cost model shift

The claude-Max-subscription question is **moot in the direction the prompt assumed**: the zero-marginal-cost claude-CLI path no longer exists, so every text synthesis call is already a paid, per-call API request through OmniRoute (default `gpt-4o-mini`, i.e. fractions of a cent per capture; at personal capture volume this is likely single-digit dollars per year, but actual OmniRoute server-side routing/markup is not visible from this repo).

The live version of the question is the reverse: *should a zero-marginal-cost path be restored?* Options, stated without a default-winner:

- **Status quo (paid per call):** negligible dollars at current volume; no infra dependency beyond OmniRoute itself.
- **Claude-Max shim** (OpenAI-compatible façade over `claude` CLI on the workstation): zero marginal cost, but re-introduces exactly the daemon + workstation-reachability dependency v0.2 deliberately removed — `TODO.md:25` already rejects the analogous Ollama variant on those grounds.
- **On-device Gemma backend** (`TODO.md:25`, already sketched): zero marginal cost *and* true offline, at the price of ~1.5 GB model, slow first token, battery. Architecturally enabled by the existing `omniroute.ts` abstraction.

This is a genuinely close call that depends on actual monthly spend → **Open Questions**.

### 1.3 Dependency shift

Removing navetted did **not** remove the reachability dependency — it moved it. If OmniRoute lives at a LAN/Tailscale address, text and vision enrichment carry the same "on the right network" requirement navetted had (this matches the recorded incident where a VPN-gated endpoint caused enrichment failures). The dependency only disappears if OmniRoute is exposed on a public HTTPS hostname (the README example `https://llm.grepon.cc` suggests this may already be the case — see Open Questions; note the code's HTTP allowlist covers `localhost`/`127.*`/`10.*` but **not** `192.168.*`, so a plain-HTTP `192.168.1.20:20128` URL would be rejected by `omniroute.ts:179-186`).

Off-network behavior today is well-defined and split by capture type:

- **Text captures** (idea/journal/person): transient/network failure → raw capture silently enqueued (AsyncStorage-backed queue, `queue.ts`), drained on reconnect, max 10 retries; 4xx/not-configured surfaces to the user and does not queue.
- **Photo/share:** never blocks — stub note + `degradedReason` banner + manual "re-enrich" (`PhotoCaptureScreen.tsx:150-165, 222-248`).
- **Audio:** unaffected (fully on-device).

### 1.4 Vision continuity risk

**This is the real gap.** One `omniRouteModel` setting serves both text and vision. Nothing in the app guarantees vision requests reach a vision-capable model:

- If the user points `omniRouteModel` at a text-only model (cheaper text model, future local Gemma), image parts will either hard-error at the proxy (acceptable — falls into the existing stub+banner path) or, worse depending on proxy behavior, be **silently dropped**, producing a confidently wrong "enrichment" with no degraded banner. The app cannot distinguish these; it never validates that the response acknowledged the image.
- The bespoke `/ocr` endpoint is a second, invisible server-side model commitment the app has no insight into.

Required routing/fallback logic for any target architecture:

1. **Per-task model map in Settings** — `chatModel` and `visionModel` as separate fields (the vestigial `omniRouteTranscriptionModel` shows the pattern already exists). Vision calls (`enrichSharedImage`, and `/ocr` if folded in) always use `visionModel`, defaulting to a known vision-capable model.
2. **Fail-loud, never silent-wrong** — keep the stub+banner policy as the only degradation mode; optionally add a cheap sanity check (e.g. prompt requires a fixed marker like a `kind: shared-image` field the model can only produce by "seeing" the instruction — already partially true via `prompts.ts:154-167` — plus reject responses that describe zero visual content).
3. **Optional capability probe** — `listModels` already exists (`omniroute.ts`); a Settings-screen "test connection" (already on `TODO.md:32`) could verify the configured vision model is served.

### 1.5 Output schema stability

The LLM emits the **complete markdown note directly** — frontmatter and body — from format-rigid prompts (`prompts.ts`: idea `:44-52`, journal `:73-86`, person `:103-124`, shared image `:154-167`, shared link `:215-232`). There is **no schema validator**: the only client-side repairs are code-fence stripping (`omniroute.ts:308,332`) and an empty-response error; malformed-but-nonempty markdown is written as-is. After enrichment, the client mutates frontmatter to inject user tags, `location: lat,lon`, and attachments (`queue.ts:47-49`, `frontmatter.ts` with byte-exact header preservation).

Because the format contract lives in the prompts (which don't change when the backend does), a backend/model swap risks *compliance*, not code. What must stay byte-/convention-compatible for the existing vault and features:

| Must not drift | Why |
|---|---|
| Frontmatter keys per type (`created`, `status`, `tags`, `date`, `people`, person contact fields, `kind`) | Obsidian/Dataview conventions; client frontmatter mutation assumes these headers parse |
| `location:` as plain `lat,lon` | established convention, injected client-side |
| `[[Name]]` wikilinks in `people:` | Obsidian graph/links |
| Journal append structure (`## HH:MM` blocks, `\n\n---\n<timestamp>\n\n` separators) | `appendJournal` merges into existing files |
| `karakeepId` frontmatter | Karakeep export idempotency |
| Filename-relevant `name` output | already hardened by allowlist (`writer.ts:599-610`) |
| Photos/Ideas pairing (`{slug}.jpg` + paired note) | `listPairedBinaries` resolution |

Safe to change: body prose style, section content, tag suggestions beyond the mandated ones.

**Recommendation within this topic:** if models will be swapped with any frequency, add a thin post-enrichment normalizer — parse frontmatter, verify required keys for the note type, re-serialize in canonical order; on failure, fall to the degraded path rather than writing a malformed note. This converts "model compliance risk" into the same fail-loud posture as vision.

### 1.6 Recommendation

**Target architecture: keep the v0.2 unified call layer (it is the architecture Task 1 asked for), and close the three real gaps rather than re-architecting.**

1. **Split model selection per task** — `chatModel` + `visionModel` settings (§1.4). Smallest change with the largest correctness payoff. Keep model choice explicit; do not build client-side auto-fallback chains — OmniRoute is the right place for server-side routing if desired.
2. **Fold business-card OCR into chat vision** — replace bespoke `POST /ocr` with `enrichSharedImage`-style `image_url` chat calls using `visionModel`. Removes the last non-OpenAI-compatible dependency and one server-side contract. *Condition:* verify VLM OCR quality on real cards matches the dedicated endpoint first (open question).
3. **Add the frontmatter validator/normalizer** (§1.5) so backend/model swaps degrade loudly instead of corrupting vault notes.
4. **Leave the cost question as an explicit user decision** (§1.2): status quo vs on-device Gemma (TODO'd, aligned with the architecture) vs claude-Max shim (works, but re-introduces the retired daemon dependency — recommend against unless spend actually becomes material).
5. **Housekeeping (doc/naming only):** retire `navetted`-named desktop keychain commands and the "OmniRoute / navetted" codemap line; remove or repurpose the vestigial transcription-model setting.

---

## Section 2 — Capture Surface Inventory

### 2.1 Existing entry points (verified shipped)

Substantially more is shipped than the prompt assumed. Taps counted from trigger to note-on-disk; typing excluded.

| # | Entry point | Flow | Taps | Evidence |
|---|---|---|---|---|
| 1 | Idea (in-app) | Home → Idea → type/dictate → **Send** (blocks on enrich) → preview → **Save** | 3 | `CaptureScreen.tsx:271-299, 366-390` |
| 2 | Journal (in-app) | Home → Journal (or "Continue today's journal") → Send → preview → Save (appends) | 3 | `CaptureScreen.tsx:302-330`; `HomeScreen.tsx:197-205` |
| 3 | Person (in-app) | Home → Contact → scan card (camera OCR) or type → Send → preview → Save | 3 | `CardScannerModal.tsx`, `ocr.ts` |
| 4 | Photo (in-app) | Home → Photo → Capture → context → Send → preview → Save; **never blocks** — stub+banner on enrich failure | 4 | `PhotoCaptureScreen.tsx:97-216` |
| 5 | Audio (in-app) | Home → Audio → record → **Stop & save**. Saves immediately, no LLM; on-device transcript async | 3 | `AudioCaptureScreen.tsx:188-375` |
| 6 | **Android share sheet** | Share from any app → Carnet target → context → Save. Handles text/URL (link enrich), image (vision enrich), audio/any file (raw persist) | 1 in-app tap | `app.json:66-71`; `ShareReceiveScreen.tsx:141-405` |
| 7 | App shortcuts (launcher long-press) | Idea/Journal/Photo/Contact → deep link straight to mode screen | long-press + mode flow | `plugins/withAppShortcuts.js` |
| 8 | Home-screen widget | 4 buttons (Idea/Journal/Photo/Audio) → same deep links | tap + mode flow | `plugins/withCaptureWidget.js` |
| 9 | Persistent notification | Foreground-service notification with 4 launch actions; survives reboot | tap + mode flow | `plugins/withCaptureNotification.js` |
| 10 | Deep links `carnet://` | `capture/:mode`, `photo`, `audio`, `settings`, `share-receive` — navigate only, never auto-save | — | `App.tsx:47-70` |

Supporting modes, all shipped: on-device voice dictation with editable transcript (`VoiceButton.tsx`, system recognizer — not Whisper); inline images in prose (#60); manual location chip (`lat,lon`, **not** auto-captured); tag input with vault autocomplete; WYSIWYG (TenTap) editor — **in RecentDetail edit mode only, not in capture**; offline queue with retry; Karakeep export (an *output*, not a capture input).

Desktop (`apps/desktop`) captures nothing — static Tauri placeholder, fate deferred to v0.3.

**Checked and confirmed absent:** Quick Settings tile (no TileService in the manifest; TODO'd for v0.3), notification inline-reply (actions are launch-only PendingIntents — `withCaptureNotification` Kotlin, no RemoteInput), clipboard *ingest* (`expo-clipboard` only copies transcripts out), `https://` App Links (only `carnet://`), iOS share extension (Android intent filters only).

### 2.2 Missing entry points, evaluated for fit

| Candidate | Verdict | Reasoning |
|---|---|---|
| URL/link capture | **Already covered** by share sheet → `enrichSharedLink` with URL preview. A dedicated in-app "paste link" mode would duplicate it for no tap savings. | — |
| File/document attachment | **Mostly covered**: share sheet persists arbitrary files to `Files/`; in-note attachments exist (`attachments.ts`). No gap worth building. | — |
| Android share sheet | **Shipped.** | — |
| **Notification inline reply (RemoteInput)** | **Best genuine gap.** The persistent notification already exists; adding a RemoteInput "quick idea" action gives *zero-app-open* text capture — type into the notification, done. This is the single biggest fewest-clicks win available. | Requires save-first/async-enrich for text (see 2.4) |
| **Clipboard capture** | **Moderate fit.** Android 10+ blocks background clipboard reads, so it must be a foreground affordance: a "capture clipboard" notification action or Home-screen chip that opens Idea pre-filled. Cheap to build on existing surfaces; not a new pipeline. | — |
| Quick Settings tile | **Low priority despite being TODO'd.** The persistent notification already provides an always-available 4-action surface with identical latency; a QS tile adds a fifth launcher for the same flows. Build only if the notification proves too easy to dismiss in practice. | — |

### 2.3 Minimum-click flows and the speed-vs-structure line

Enrichment interacts with save in three distinct timing models today, and they define where speed is traded for structure:

1. **Text modes (idea/journal/person): enrich-then-preview-then-save.** The LLM call *blocks* between Send and preview; the note doesn't exist until the explicit Save tap. Cost: seconds of blocking + one extra tap per capture. Benefit: the user vets the synthesis before it enters the vault. Offline: raw capture silently queues.
2. **Photo/share: save-guaranteed, enrich-best-effort.** Stub + degraded banner + re-enrich button. The note always lands.
3. **Audio: save-first, enrich-async.** Fastest model; transcript arrives later, idempotently.

Where each capture type should sit:

- **Idea and Journal should be bare-minimum-click.** These are the "get the thought down before it evaporates" modes; the blocking Send + preview + Save is the slowest flow in the app on precisely the captures that most need speed. A per-mode or global "quick save" option (write raw immediately, enrich async, banner if enrichment fails — i.e., adopt the photo/share model) would cut idea capture to Home → Idea → type → one tap, and enables notification inline reply. The preview should remain available, but as opt-in friction rather than mandatory.
- **Person justifies the extra structure.** Wrong contact data (names, emails, phones) is costly and OCR is fallible; the review step earns its tap. Keep enrich-then-preview.
- **Photo/share/audio are already right.** Save-first with visible degradation is the correct posture; don't add preview gates.
- **Tags and location are correctly optional adds** (manual chip / autocomplete). Auto-location would save a tap at a privacy/battery cost — reasonable as an off-by-default setting, not a default.

### 2.4 Conflicts between entry points and the Section 1 architecture

- **Notification inline reply and any "quick save" mode conflict with the current blocking enrich-preview flow for text captures** — they require the save-first/async-enrich model (§2.3). This is a UX-policy change, not an architecture change: the queue, stub-fallback, and re-enrich machinery it needs all exist already. It is the one decision that gates the biggest capture-speed win → Open Questions.
- **On-device Gemma backend (TODO) aligns, doesn't conflict:** it strengthens every capture surface offline, and the `omniroute.ts` interface was explicitly shaped for a sibling backend. But it sharpens the vision-routing gap (§1.4): a local text-only backend must never receive image parts — per-task model/backend selection becomes mandatory, not nice-to-have, before that lands.
- **No capture mode depends on a synthesis path Section 1 proposes to remove.** The only removal candidate is the bespoke `/ocr` endpoint, used solely by the business-card scanner, and the proposal replaces it in place with chat vision. Whisper remnants (`VoiceButton.tsx:41-44` keys, vestigial transcription-model setting) are dead weight, not dependencies.

---

## Open Questions

1. **OmniRoute transport reality check.** The app rejects plain HTTP except `localhost`/`127.*`/`10.*` (`omniroute.ts:179-186`) — `192.168.1.20:20128` over plain HTTP would be refused. Is the real configured URL an HTTPS hostname (e.g. `https://llm.grepon.cc`) fronting that box? This determines whether §1.3's reachability constraint is "LAN/Tailscale-gated" or "public-internet". 
2. **Cost tolerance / volume.** Actual monthly OmniRoute spend at current capture volume is unknown from the repo. Status quo vs on-device Gemma vs a claude-Max shim (§1.2) genuinely depends on that number and on how much the retired-daemon principle is worth; not resolvable from code.
3. **Vision model policy location.** Should vision correctness be enforced client-side (separate `visionModel` setting, recommended in §1.4) or server-side (OmniRoute routes by request shape)? Server config is outside this repo; if OmniRoute already guarantees vision routing, the client-side split is belt-and-suspenders rather than essential.
4. **`/ocr` quality bar.** Folding card OCR into chat vision (§1.6.2) is only correct if VLM OCR on real business cards matches the dedicated endpoint. Needs a small side-by-side test on device; the server-side implementation of `/ocr` is not visible from this repo.
5. **Save-first for text captures.** Adopting async enrichment for Idea/Journal (§2.3) trades the pre-save preview for speed and unlocks notification inline reply. Keep preview as default with a quick-save option, or flip the default? User-preference call.
6. **Vestigial transcription setting.** `omniRouteTranscriptionModel` is dead (transcription is on-device) but `TODO.md:24` still contemplates Whisper→OmniRoute consolidation. Remove the setting, or keep it pending that decision?
7. **Quick Settings tile.** TODO'd for v0.3, but the persistent notification already covers the same latency profile (§2.2). Keep on the roadmap or drop?
