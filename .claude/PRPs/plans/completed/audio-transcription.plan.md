# Plan: Audio transcription via OmniRoute Whisper (slate #4 part 2)

## Summary
Adds on-demand transcription for audio notes. New "Transcribe" button on RecentDetail (gated on `kind: shared-audio`) reads the paired `.m4a`, posts to OmniRoute's `/v1/audio/transcriptions` (OpenAI-compatible multipart endpoint), and idempotently upserts a `## Transcript` section into the existing note. Works on both PR #16's audio captures AND PR #7's audio shares — both use the same `shared-audio` kind. Transcription model is a new Settings field (default `whisper-1`) so the chat model stays untouched.

## User Story
As a carnet user who recorded a voice memo or shared an audio clip,
I want to tap one button to transcribe it into searchable text in my Obsidian vault,
So that future-me can grep my voice notes the same way I grep my typed ones.

## Problem → Solution
**Current:** Audio captures + audio shares save a stub markdown note with a `[link](../Audio/foo.m4a)` and no text content. The audio is in the vault but invisible to search, untaggable, and only useful if you remember exactly which note has which audio. Obsidian's mobile audio player is workable but the friction is high.

**Desired:** Tap Transcribe on the recent → 5-30s later the note has a `## Transcript` section with searchable text. Re-running replaces the transcript in place (e.g. after retrying a noisy recording with a better model). The original file stays in `Audio/` untouched so the user can always re-listen.

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A — slate #4 follow-up
- **PRD Phase:** v0.3
- **Estimated Files:** 1 new test + 5 modified
- **Confidence Score:** 8/10 — main unknown is OmniRoute/LiteLLM proxy behavior on `/v1/audio/transcriptions` (assumed to proxy Whisper transparently; needs on-device verification). RN FormData + Blob upload shape is the second risk.

---

## UX Design

### Flow
```
RecentDetail (audio note today)            RecentDetail (after this PR)
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│ Audio note: audio-2026...m4a     │       │ Audio note: audio-2026...m4a     │
│ Audio · 5 min ago                │       │ Audio · 5 min ago                │
│                                  │       │                                  │
│ ## File                          │       │ ## File                          │
│ [audio-2026...m4a]              │       │ [audio-2026...m4a]              │
│                                  │       │                                  │
│ ## Context                       │       │ ## Context                       │
│ (none provided)                  │       │ (none provided)                  │
│                                  │       │                                  │
│                                  │       │ ## Transcript                    │
│                                  │       │ So I was thinking about the     │
│                                  │       │ Q3 roadmap and we should…       │
│                                  │       │                                  │
│ [Delete]                         │       │ [Transcribe] [Delete]            │
└──────────────────────────────────┘       └──────────────────────────────────┘
                                                   │
                                                   ▼ tap Transcribe
                                           ┌──────────────────────────────────┐
                                           │  ⟳ Transcribing audio…           │
                                           │  (inline loader, matches         │
                                           │   Re-enrich's spinner)           │
                                           └──────────────────────────────────┘
                                                   │
                                                   ▼ ~5-30s
                                           Updated body, new ## Transcript
                                           section inline, scrolls into view.
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| RecentDetail Card.Actions | `[Re-enrich?] [Delete]` | `[Transcribe?] [Re-enrich?] [Delete]` | Transcribe shows when `kind === "shared-audio"`. Re-enrich keeps its existing `shared-image \| photo` gate — mutually exclusive in practice. |
| Inline loader copy | "Re-running vision enrichment…" | + "Transcribing audio…" variant | Same `inlineLoading` View, parametric text. |
| Settings | One `omniRouteModel` field | + `omniRouteTranscriptionModel` field | Defaults to `whisper-1`. Lives under the chat model in the form, no separate section needed. |
| Saved markdown | `## File\n## Context` | + optional `## Transcript` after Context (or replacing existing) | Idempotent — re-runs replace the Transcript body, never the rest. |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/omniroute.ts` | 134-213 | `executeChat` shape — sanitization, HTTPS guard, FETCH_TIMEOUT_MS, error classification. Mirror these in `transcribeAudio`. |
| P0 | `apps/mobile/src/lib/omniroute.ts` | 390-425 | `enrichSharedImage` — base64 + mime payload handling + executor wiring. The transcription function follows this shape but POSTs multipart, not JSON. |
| P0 | `apps/mobile/src/lib/settings.ts` | 32-63, 77-119 | Settings shape + persistence + DEFAULT_PERSISTED — how to add a new field without breaking the existing migration. |
| P0 | `apps/mobile/src/screens/SettingsScreen.tsx` | 66-71, 151-177, 308-329 | FormState shape + save() + Model field UI — clone the Model field for the transcription model. |
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | 40, 112-150, 156-157, 195-202, 226-235 | Re-enrich flow end-to-end — mirror the button gate, the busy state, the error banner, the inline loader. |
| P0 | `apps/mobile/src/lib/writer.ts` | 798-816 | `readPairedBinaryFromNote` — already returns `{ base64, mime }` for audio files via the same regex. Reuse as-is. |
| P0 | `apps/mobile/src/lib/writer.ts` | 305-314 | `injectImageEmbed` — pattern for in-body markdown surgery via regex. `upsertSection` follows a similar shape (find → splice → return). |
| P1 | `apps/mobile/src/lib/omniroute.test.ts` | (mock fetch setup) | Test the new `transcribeAudio` with the same fetch-mock pattern existing tests use. |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| FormData multipart in RN | new code | `fetch(`data:${mime};base64,${b64}`).then(r => r.blob())` → `formData.append("file", blob, filename)` — RN's fetch+Blob handle this on Android. |
| Whisper endpoint | OmniRoute / LiteLLM | `POST /v1/audio/transcriptions` with `file` + `model` + optional `language`, `response_format`, `prompt`. Returns `{ text: "..." }` for JSON format. |
| Bearer + HTTPS guard | `omniroute.ts:144-161` | Reused verbatim in `transcribeAudio`. |
| Error classification | `omniroute.ts:79-93` | `OmniRouteError` carries status. Whisper errors classify the same way. |
| Bytes cap | `omniroute.ts:105-123` | `MAX_SHARED_IMAGE_BYTES = 8 MB` for vision. Whisper caps at 25 MB — a new constant. |
| Idempotent section upsert | new code in `writer.ts` | Split markdown into lines; scan for `## {heading}`; if found, replace lines until next `## ` or `# `; else append. Pure function, easy to test. |
| Settings migration | `settings.ts:77-90` | Existing `{...DEFAULT_PERSISTED, ...parsed}` spread handles new fields. Just add to DEFAULT_PERSISTED. |

---

## Patterns to Mirror

### TRANSCRIBE_FUNCTION (new, modeled on enrichSharedImage)
```ts
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;  // Whisper hard cap

/** Soft cap for the transcription model name when settings.transcriptionModel is empty. */
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

export async function transcribeAudio(input: {
  base64: string;
  mimeType: string;
  filename: string;
}): Promise<{ text: string; model: string }> {
  const approxBytes = Math.floor(input.base64.length * 0.75);
  if (approxBytes > MAX_TRANSCRIPTION_BYTES) {
    const mb = Math.round(approxBytes / 1024 / 1024);
    const capMb = Math.round(MAX_TRANSCRIPTION_BYTES / 1024 / 1024);
    throw new OmniRouteError(
      `Audio is ${mb} MB — Whisper caps at ${capMb} MB. Split or compress before transcribing.`,
      413,
    );
  }

  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getTranscriptionModel(),  // new helper
  ]);

  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  // Same HTTPS guard as executeChat — copy/paste rather than refactor
  // executeChat. Two consumers don't justify extracting the guard yet.
  if (!/^https:\/\//i.test(trimmed)) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|10\.)/i.test(trimmed);
    if (!isLocal) {
      throw new OmniRouteError(
        "OmniRoute URL must use https:// to protect the API key",
        0,
      );
    }
  }

  // RN's fetch handles data: URIs. Round-tripping through Blob is the
  // canonical way to attach binary bytes to a multipart FormData without
  // requiring filesystem access.
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append("file", blob, input.filename);
  form.append("model", model);
  form.append("response_format", "json");  // {text: "..."}

  const url = `${trimmed}/v1/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        // No Content-Type: let fetch set the multipart boundary.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: form as unknown as BodyInit,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    const raw = e instanceof Error ? e.message : String(e);
    throw new OmniRouteError(`OmniRoute network error — ${sanitizeErrorMessage(raw)}`, 0);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as OpenAIResponse;
      if (errBody.error?.message) {
        detail += `: ${sanitizeErrorMessage(errBody.error.message)}`;
      }
    } catch {
      /* parse failure — status is enough */
    }
    throw new OmniRouteError(`OmniRoute transcription error — ${detail}`, response.status);
  }

  const json = (await response.json()) as { text?: string };
  const text = json.text?.trim() ?? "";
  if (!text) {
    throw new OmniRouteError("Whisper returned an empty transcript", response.status);
  }
  return { text, model };
}
```

### UPSERT_SECTION (new in writer.ts)
```ts
/**
 * Idempotently insert-or-replace an H2 section in a markdown body.
 *
 *   - If `## {heading}` exists, replace everything from that line through
 *     the next `## ` / `# ` / end-of-file with `## {heading}\n\n{body}\n`.
 *   - If it doesn't exist, append `\n## {heading}\n\n{body}\n` to the end.
 *
 * Heading match is exact and case-sensitive ("## Transcript" matches,
 * "##  Transcript" does not). Frontmatter and H1 are untouched.
 *
 * Returns the new markdown. Pure function, no I/O — caller wires updateNote.
 */
export function upsertSection(markdown: string, heading: string, body: string): string {
  const headingLine = `## ${heading}`;
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((l) => l === headingLine);

  if (startIdx === -1) {
    // Append. Normalize trailing newline so output always ends with exactly one.
    const trimmed = markdown.replace(/\n+$/, "");
    return `${trimmed}\n\n${headingLine}\n\n${body}\n`;
  }

  // Find the end of the section — next H2/H1 line, or EOF.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const replacement = [headingLine, "", body];
  // Preserve the blank line between sections if `after` doesn't start with one.
  if (after.length > 0 && after[0] !== "") replacement.push("");
  return [...before, ...replacement, ...after].join("\n");
}
```

### SETTINGS_MIGRATION (additive)
```ts
// settings.ts
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

export interface Settings {
  // ... existing fields ...
  omniRouteTranscriptionModel: string;
}

interface PersistedSettings {
  // ... existing fields ...
  omniRouteTranscriptionModel: string;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  // ... existing ...
  omniRouteTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
};
```
The existing `{...DEFAULT_PERSISTED, ...parsed}` spread in `readPersisted` handles backfill — users upgrading from PR #16's settings shape automatically get `whisper-1` on first read.

### RECENT_DETAIL_BUTTON (mirror existing Re-enrich)
```tsx
// alongside canReEnrich:
const canTranscribe = kind === "shared-audio";

// alongside reEnriching:
const [transcribing, setTranscribing] = useState(false);
const [transcribeError, setTranscribeError] = useState<string | null>(null);
const transcribingRef = useRef(false);

const handleTranscribe = useCallback(async () => {
  if (transcribingRef.current) return;
  transcribingRef.current = true;
  setTranscribeError(null);
  setTranscribing(true);
  try {
    // Pull paired binary URI + bytes. readPairedBinaryFromNote already returns
    // base64 + mime, and the body's link gives us the filename for the
    // multipart payload.
    const linkMatch = body.match(/\.\.\/Audio\/([^/\s)]+)/);
    if (!linkMatch) throw new Error("No paired audio link found in this note.");
    const filename = linkMatch[1];
    const { base64, mime } = await readPairedBinaryFromNote(body);
    const { text } = await transcribeAudio({ base64, mimeType: mime, filename });
    const next = upsertSection(body, "Transcript", text);
    await updateNote(entry.filepath, next);
    setBody(next);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[RecentDetail] transcribe failed:", reason);
    setTranscribeError(reason);
  } finally {
    transcribingRef.current = false;
    setTranscribing(false);
  }
}, [body, entry.filepath]);

// In Card.Actions:
{canTranscribe ? (
  <Button
    mode="text"
    icon="text-recognition"
    onPress={handleTranscribe}
    disabled={missing || transcribing || reEnriching}
  >
    Transcribe
  </Button>
) : null}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/omniroute.ts` | UPDATE | Add `transcribeAudio`, `getTranscriptionModel`, `MAX_TRANSCRIPTION_BYTES`, `DEFAULT_TRANSCRIPTION_MODEL` |
| `apps/mobile/src/lib/settings.ts` | UPDATE | Add `omniRouteTranscriptionModel` field, update Settings/PersistedSettings/DEFAULT_PERSISTED, re-export `DEFAULT_TRANSCRIPTION_MODEL` |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | New TextInput for transcription model, FormState field, save() pass-through |
| `apps/mobile/src/lib/writer.ts` | UPDATE | Export new `upsertSection(markdown, heading, body)` helper |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | Transcribe button, busy state, error banner, inline loader |
| `apps/mobile/src/lib/writer.test.ts` | UPDATE | Tests for `upsertSection` (append, replace, multi-section, EOF edge) |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATE | Tests for `transcribeAudio` happy + error paths (mock fetch) |

## NOT Building
- **Auto-transcribe at save time in AudioCaptureScreen** — explicit user choice. Saves API cost on throwaway voice memos. Trivial to add later: call `transcribeAudio` + `upsertSection` after `writeIdea` in `stopAndSave`, gate on a new setting `autoTranscribe: boolean`.
- **Diarization, timestamps, or speaker labels** — Whisper's `response_format: verbose_json` carries segments + timestamps. Out of scope; adds parser code and a richer markdown shape. The plain text transcript is the v0.3 ask.
- **Language hint / prompt biasing** — the Whisper API supports `language` + `prompt` parameters for biasing toward technical terms or a known language. Out of scope; defer until a user reports bad transcriptions on their domain vocabulary.
- **A second LLM pass to summarize / structure the transcript** — would produce a richer note (title-from-content, key-points, action-items). Real value but doubles the API cost and adds latency. Defer to a "summarize transcript" follow-up if users ask for it.
- **Transcription progress / streaming** — Whisper's transcription endpoint isn't streamable in the OpenAI-compatible shape. A 60s clip transcribes in ~3-10s; the inline spinner is enough.
- **Retry queue for transient transcription failures** — the share-pipeline queue lives in queue.ts for offline-then-online enrichment. A future PR could route transcription through it; for now a failed Transcribe just leaves the note untouched and surfaces an error banner.
- **Per-note transcription model override** — only the global Settings field. If users want per-note control, that's a follow-up alongside per-mode prompt overrides.

---

## Step-by-Step Tasks

### Task 1: Add transcription model field to Settings
- **ACTION:** Edit `apps/mobile/src/lib/settings.ts`.
- **IMPLEMENT:**
  1. Add `export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";` near `DEFAULT_OMNIROUTE_MODEL`.
  2. Add `omniRouteTranscriptionModel: string;` to `Settings` AND `PersistedSettings`.
  3. Add `omniRouteTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL` to `DEFAULT_PERSISTED`.
  4. Pass through in `readPersisted`, `writePersisted`, `getSettings`, `saveSettings` — the existing spread pattern handles read backfill; write needs explicit field copy.
- **MIRROR:** `SETTINGS_MIGRATION` block above.
- **GOTCHA:**
  - DON'T add to `LegacyPersistedSettings` (v0.1 migration shape) — only forward defaults matter.
  - The default `"whisper-1"` is the canonical OpenAI Whisper model name. On a LiteLLM-proxied OmniRoute instance, this typically routes to OpenAI's hosted Whisper. Some self-hosted proxies use namespaces like `openai/whisper-1` — user-editable so the default doesn't matter long-term.
- **VALIDATE:** typecheck after editing — Settings type change cascades to SettingsScreen which will surface a missing-field error in `FormState`.

### Task 2: Add transcription model field to SettingsScreen
- **ACTION:** Edit `apps/mobile/src/screens/SettingsScreen.tsx`.
- **IMPLEMENT:**
  1. Add `omniRouteTranscriptionModel: string;` to `FormState`.
  2. Update the `useEffect` initializer + `save()` to thread the field through.
  3. Import `DEFAULT_TRANSCRIPTION_MODEL` from settings.
  4. Add a new `<TextInput label="Transcription model" />` below the existing Model field. Same shape as the Model field minus the Browse button (Whisper-compatible models aren't typically in the chat catalog).
  5. Save: use `form.omniRouteTranscriptionModel || DEFAULT_TRANSCRIPTION_MODEL` for the default-on-empty fallback.
- **MIRROR:** Existing Model field at lines 308-329.
- **GOTCHA:**
  - Do NOT extend the "Browse available models" button to fetch transcription models — different endpoint (`/v1/models` lists chat by convention; Whisper models are a separate namespace on most proxies). Keep the field as a plain TextInput with the default as placeholder.
- **VALIDATE:** Manual on-device — open Settings, see the new field, save, re-open, confirm persistence.

### Task 3: Add transcribeAudio + getTranscriptionModel + cap to omniroute.ts
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.ts`.
- **IMPLEMENT:**
  1. Add `MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024` near `MAX_SHARED_IMAGE_BYTES`.
  2. Add private `getTranscriptionModel()` helper mirroring `getModel()`:
     ```ts
     async function getTranscriptionModel(): Promise<string> {
       const settings = await getSettings();
       return settings.omniRouteTranscriptionModel.trim() || "whisper-1";
     }
     ```
  3. Add public `transcribeAudio({ base64, mimeType, filename })` per `TRANSCRIBE_FUNCTION` above.
- **MIRROR:** `enrichSharedImage` for the shape; `executeChat` for the HTTPS guard + sanitization + AbortController + error wrapping.
- **IMPORTS:** none new (FormData/Blob/fetch are globals; sanitizeErrorMessage already in module).
- **GOTCHA:**
  - **Do NOT set `Content-Type` header explicitly when sending FormData** — RN's fetch needs to add the `multipart/form-data; boundary=...` header itself. Setting it manually breaks multipart parsing on the server.
  - **The 25 MB cap is real** for OpenAI Whisper. LiteLLM proxies enforce it upstream. Don't let users get to a confusing 413 from the provider — pre-check.
  - **Empty response body** — Whisper returns `{text: ""}` if it detected only silence. Treat empty-string as an error so users see "Whisper returned an empty transcript" instead of an empty Transcript section that looks like the feature broke.
  - **`response_format: "json"`** is the default but explicit is safer. Don't use `verbose_json` (parser overhead, out of scope) or `text` (returns plain text, not JSON — would need different parse logic).
- **VALIDATE:** Unit test in Task 6.

### Task 4: Add upsertSection helper to writer.ts
- **ACTION:** Edit `apps/mobile/src/lib/writer.ts`.
- **IMPLEMENT:** Per `UPSERT_SECTION` above. Place near `injectImageEmbed` (line 305-314) since both are public markdown-surgery helpers.
- **GOTCHA:**
  - **Heading match is exact-line** — `## Transcript` matches, `## Transcript ` (trailing space) doesn't, `##  Transcript` (double space) doesn't. This is deliberate — Obsidian's heading parser is also strict. The transcript writer always emits `## Transcript` exactly so re-runs always find their previous section.
  - **The "next section" boundary** stops at any H1 (`# `) or H2 (`## `). H3+ (`### `) is treated as part of the current section's body — that's intentional, lets the transcript include `### Speakers` or similar subheadings without being truncated.
  - **EOF normalization** — append path strips ALL trailing newlines first, then adds exactly one blank line + the section + a trailing newline. Replace path preserves whatever was after the section.
- **VALIDATE:** Unit tests in Task 6.

### Task 5: Wire the Transcribe button in RecentDetailScreen
- **ACTION:** Edit `apps/mobile/src/screens/RecentDetailScreen.tsx`.
- **IMPLEMENT:** Per `RECENT_DETAIL_BUTTON` above.
  1. Add imports: `transcribeAudio` from `../lib/omniroute`, `upsertSection` from `../lib/writer`.
  2. Add `transcribing`, `transcribeError` state + `transcribingRef`.
  3. Add `handleTranscribe` callback.
  4. Add `canTranscribe = kind === "shared-audio"` next to `canReEnrich`.
  5. In Card.Actions: render `<Button>Transcribe</Button>` when `canTranscribe`. Disable when `missing || transcribing || reEnriching`.
  6. Render a `transcribeError` Banner alongside `reEnrichError`.
  7. Render the inline loader with copy "Transcribing audio…" when `transcribing`.
- **MIRROR:** The Re-enrich block at lines 112-150 + 226-235 — same shape, replace verbs.
- **IMPORTS:** `transcribeAudio` from `../lib/omniroute`, `upsertSection` from `../lib/writer`.
- **GOTCHA:**
  - **Re-enrich and Transcribe gate on different `kind` values** (`shared-image|photo` vs `shared-audio`) so they're never both visible at once. The disabled-when-other-is-running guard is still important — if a future kind value enables both buttons, the guard prevents racing the LLM.
  - **The `readPairedBinaryFromNote` regex already handles `Audio/` subdir** — its match is `(Photos|Audio|Files)`. Reuse as-is; no changes to writer.ts.
  - **Don't trim the transcript** — leading whitespace might be meaningful (e.g. Whisper emits a leading space sometimes). The `text.trim()` happens once in `transcribeAudio`'s empty-check, but the body passed to `upsertSection` should be the trimmed version so the new section doesn't start with a blank line.
- **VALIDATE:** Manual on-device.

### Task 6: Tests — upsertSection + transcribeAudio
- **ACTION:** Edit `apps/mobile/src/lib/writer.test.ts` and `apps/mobile/src/lib/omniroute.test.ts`.
- **IMPLEMENT:**
  - **writer.test.ts** — new `describe("upsertSection")` block with cases:
    - appends when heading missing (no trailing newline edge)
    - appends when heading missing (existing trailing newline edge)
    - replaces single-section body
    - replaces when section is followed by another H2 (boundary preserved)
    - replaces when section is followed by an H1 (boundary preserved)
    - replaces when section is at EOF (no following section)
    - does not match `## Transcript ` (trailing space) — appends instead
    - leaves frontmatter untouched
    - leaves H1 untouched
    - returns identical output if body is identical to existing section (idempotency)
  - **omniroute.test.ts** — new `describe("transcribeAudio")` block:
    - happy path: fetch mock returns `{text: "hello world"}`, function returns `{text: "hello world", model}`
    - error path: fetch mock returns 401, throws `OmniRouteError` with status 401
    - error path: fetch mock returns 413, throws with status 413
    - error path: empty text, throws "Whisper returned an empty transcript"
    - validation: payload > 25 MB throws 413 before fetching
    - validation: http:// non-local URL throws HTTPS error
- **MIRROR:** Existing fetch-mock pattern in `omniroute.test.ts` (the `enrichIdea` / `enrichSharedImage` tests).
- **GOTCHA:**
  - **FormData in Node** — vitest's default jsdom env has FormData. Blob may need a polyfill; if so, mock `global.fetch` to ignore the body shape entirely (the test asserts on the URL + headers + the JSON response, not on the multipart body bytes).
  - **The base64 → Blob round-trip** uses `fetch('data:...')` which is hard to mock cleanly. Tests should mock `global.fetch` once, route the data: URI fetch to return a stub Blob, and the API fetch to return the JSON. OR: extract the Blob construction into a tiny helper and stub it in the test.
- **VALIDATE:** `npm -w @carnet/mobile run test` — 170+ tests pass, +~15-20 new.

### Task 7: Validate everything
- **ACTION:** Run `npm -w @carnet/mobile run typecheck` and `npm -w @carnet/mobile run test`.
- **EXPECT:** 0 type errors. Tests: 170 + new ones (~185-190 total) all green.
- **REBUILD:** No native changes — JS-only, live-reloads on the dev client.

---

## Testing Strategy

### Unit Tests
Per Task 6 — heavily covered for the two pure functions (`upsertSection`, the validation paths in `transcribeAudio`). The fetch-mocked happy/error paths give us regression coverage on the Whisper integration without needing a live OmniRoute instance.

### Edge Cases Checklist
- [ ] Tap Transcribe on a `shared-audio` note → spinner → text appears under `## Transcript`
- [ ] Tap Transcribe twice → second run replaces transcript in place (idempotency)
- [ ] Tap Transcribe on a note where the user manually edited `## Transcript` in Obsidian → user edits LOST (documented limitation, acceptable trade for idempotency)
- [ ] Tap Transcribe when API key is wrong → 401 banner with sanitized error message (Bearer not leaked)
- [ ] Tap Transcribe when audio file was deleted/moved in Obsidian → "Paired binary not found" error (already handled by `readPairedBinaryFromNote`)
- [ ] Tap Transcribe with no network → AbortController fires at 60s, "OmniRoute network error" banner
- [ ] Tap Transcribe on a 30 MB recording → 413 banner before fetch fires (pre-check)
- [ ] Tap Transcribe on a silent recording → "Whisper returned an empty transcript" banner (not an empty section in the note)
- [ ] Settings → new Transcription model field renders, saves, persists across reopen
- [ ] Regression: existing Re-enrich on `photo` / `shared-image` still works
- [ ] Regression: existing capture flows still work
- [ ] Regression: PR #16 audio recording still works

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 170+ tests pass (new tests counted separately).

### On-device manual
```bash
cd apps/mobile && npm run android
```
EXPECT: Audio recents have a Transcribe button; tapping produces a transcript in the .md.

### Manual smoke test
- [ ] Record a short voice note (5-10s) → save → tap recent → tap Transcribe → verify transcript appears
- [ ] Re-tap Transcribe on the same note → transcript replaced in place, no duplicate section
- [ ] Open the .md in a desktop editor → verify YAML frontmatter, file link, context, and transcript sections in that order

---

## Acceptance Criteria
- [ ] `kind: shared-audio` notes get a Transcribe button in RecentDetail
- [ ] Tapping Transcribe transcribes via OmniRoute Whisper, replaces/appends `## Transcript` section
- [ ] Re-running Transcribe replaces the existing transcript (idempotent)
- [ ] Settings has a new `omniRouteTranscriptionModel` field with default `whisper-1`
- [ ] Error states surfaced as banners (HTTP 4xx, network, empty transcript, oversized payload)
- [ ] 0 type errors; all existing 170 tests still pass; new unit tests added for both pure functions

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OmniRoute / LiteLLM proxy doesn't expose `/v1/audio/transcriptions` | Medium | Feature dead on user's instance | Surface the proxy's error verbatim. Document in settings help text. Can also fall back to a direct OpenAI Whisper call if user provides an OpenAI key — defer that. |
| RN `fetch` + FormData + Blob breaks on a specific Android version | Low | Transcribe never works for some users | Test on a real device early. If it breaks, fall back to base64 JSON body via a non-standard endpoint shim, or use `expo-file-system/legacy.uploadAsync` which natively handles multipart. |
| User's transcription model name is wrong (e.g. `whisper-1` not on their proxy) | High | First-tap failure with confusing 404 | Default to `whisper-1` (most common); error banner surfaces the proxy's response so user sees `"unknown model"`; they edit Settings + retry. |
| `## Transcript` heading collides with a user-edited section in their own notes | Very low | upsertSection clobbers their content | Heading is exact-match — they'd have to use `## Transcript` themselves which is unlikely outside this feature. Documented in NOT Building. |
| Whisper transcribes wrong language (user speaks French, default is English) | Medium | Transcript is gibberish | Auto-detect is Whisper's default and works for the major languages. If a user complains, the `language` param is a 1-line addition to `transcribeAudio` later. |
| Multipart upload pegs JS heap for a large recording | Low | OOM on a 24 MB recording | The 25 MB cap + the existing AudioCaptureScreen 200 MB share cap leave plenty of headroom. Real risk is Blob duplication during FormData serialization — `fetch` should stream it but RN's polyfill historically buffered. Accept until measured. |

## Notes
- This PR completes slate #4. With recording (PR #16) + transcription (this PR), audio captures are first-class searchable notes in carnet's vault.
- The `kind: shared-audio` reuse decision from PR #16 pays off here — one button covers both share-receive and in-app capture audio entries without branching.
- Auto-transcribe at save time is a low-cost follow-up if users routinely tap Transcribe on every recording. The plumbing in this PR makes it a 3-line change in AudioCaptureScreen.
- A future "Polish transcript" button could send the raw Whisper output through the chat model to add punctuation, paragraph breaks, and a summary. Defer until users ask.
