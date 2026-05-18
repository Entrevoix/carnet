# Plan: URL share preview fetch

## Summary
When a URL is shared into carnet, fetch the page server-side from the phone, extract `<title>` / `<meta og:title>` / `<meta og:description>` / first paragraph, and feed those to the OmniRoute prompt instead of letting the model summarize blindly from the URL string. Produces real summaries based on actual page content, not LLM guesswork.

## User Story
As a carnet user,
I want the URL I share to be fetched and summarized based on its actual content,
So that the saved markdown isn't just "this is probably about X based on the URL slug" — it's a real summary.

## Problem → Solution
**Current:** `enrichSharedLink` sends the URL string + optional snippet + user context to the model. Model has to guess from the URL alone. Result: generic summaries that hallucinate or stay shallow.
**Desired:** Fetch the URL, extract structured metadata (title + description + first paragraph), pass into the prompt. Model produces an informed summary. Falls back gracefully when fetch fails (offline, 4xx, paywall, etc.).

## Metadata
- **Complexity:** Small-to-Medium
- **Source PRD:** N/A
- **PRD Phase:** N/A
- **Estimated Files:** 3 modified + 1 new + 1 test = 5

---

## UX Design
Internal change — no user-facing UX transformation beyond markdown quality.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Share URL → saved markdown | Generic summary derived from URL string | Summary that quotes / paraphrases page content | Same Save flow, better output |
| Share offline | Same generic summary | Generic summary with `(could not fetch preview)` note in degraded banner | Soft-degrade |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/omniroute.ts` | `enrichSharedLink` (~25 lines around line 360) | Where to thread the preview into the call |
| P0 | `apps/mobile/src/lib/prompts.ts` | `buildSharedLinkPrompt` | Where to add a `preview` parameter (the fetched title/desc) |
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | the `url || text` branch in `save()` | Where to call the new fetch helper before `enrichSharedLink` |
| P1 | `apps/mobile/src/lib/omniroute.ts` | the fetch + AbortController + timeout pattern | Mirror it in the new preview fetcher |
| P2 | `apps/mobile/src/lib/omniroute.test.ts` | full | Test pattern for fetch-mocked tests — exact same shape for the new urlpreview tests |

## External Documentation
None. Standard `fetch` + HTML parsing.

---

## Patterns to Mirror

### TIMED_FETCH_WITH_ABORT
```ts
// SOURCE: apps/mobile/src/lib/omniroute.ts chatCompletion (around line 110)
const FETCH_TIMEOUT_MS = 60_000;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
try {
  response = await fetch(url, { method, headers, body, signal: controller.signal });
} catch (e: unknown) {
  clearTimeout(timer);
  throw new OmniRouteError(`network error — ${sanitizeErrorMessage(e.message)}`, 0);
}
clearTimeout(timer);
```

### MOCKED_FETCH_TEST_SHAPE
```ts
// SOURCE: apps/mobile/src/lib/omniroute.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function makeOkResponse(body: string, contentType = "text/html"): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

beforeEach(() => fetchMock.mockReset());
```

### PROMPT_BUILDER_SIGNATURE
```ts
// SOURCE: apps/mobile/src/lib/prompts.ts
export function buildSharedLinkPrompt(url: string, text: string, context: string): PromptPair {
  // string template returns { system, user }
}
// → add preview param:
// buildSharedLinkPrompt(url: string, text: string, context: string, preview: UrlPreview | null): PromptPair
```

### ENRICH_FAILURE_DEGRADED_PATH (already exists, reuse)
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx (save() → catch)
try {
  const result = await enrichSharedLink({ url, text, context: ctx });
  enrichedMd = result.markdown;
} catch (e: unknown) {
  setDegradedReason(reason);
  enrichedMd = `... stub note ...`;
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/urlpreview.ts` | CREATE | New helper: `fetchUrlPreview(url): Promise<UrlPreview \| null>`. Owns fetch + parse + timeout + graceful failure. |
| `apps/mobile/src/lib/urlpreview.test.ts` | CREATE | Tests for the parser given mocked HTML responses. |
| `apps/mobile/src/lib/prompts.ts` | UPDATE | Extend `buildSharedLinkPrompt` to accept a `UrlPreview \| null` and inject title/description/excerpt into the user message. |
| `apps/mobile/src/lib/omniroute.ts` | UPDATE | `enrichSharedLink` calls `fetchUrlPreview` when `url` is set, threads result into `buildSharedLinkPrompt`. |
| `apps/mobile/src/screens/ShareReceiveScreen.tsx` | UPDATE (optional) | If we want a separate "fetching preview…" sub-state in the spinner, add it. Otherwise no change. |

## NOT Building
- **Full HTML rendering / readability extraction.** No `@mozilla/readability`-style heuristics. Just `<title>` + a few og:* tags + first `<p>`.
- **JavaScript-rendered SPA support.** We hit the raw HTML; SPAs that render their title via JS will fall back to the URL-string-only path.
- **Image / favicon download.** We don't render previews in carnet; we just feed the LLM more text.
- **CORS bypass / proxy.** Direct fetch from the phone with the user's network access.
- **Caching.** Each share is one-off; no persistent preview cache.

---

## Step-by-Step Tasks

### Task 1: Create `urlpreview.ts` with the fetch + parse helper
- **ACTION:** New file `apps/mobile/src/lib/urlpreview.ts` exporting:
  ```ts
  export interface UrlPreview {
    title: string;       // best of <title>, og:title
    description: string; // og:description, twitter:description, first <p>
    siteName: string;    // og:site_name or hostname
    contentType: string; // from response headers
  }
  export async function fetchUrlPreview(url: string): Promise<UrlPreview | null>;
  ```
- **IMPLEMENT:**
  - Validate URL via `new URL(url)`; return null on parse failure.
  - 8-second AbortController timeout (faster than chat completion because preview is best-effort).
  - `fetch(url, { method: "GET", signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; carnet/0.2; +https://github.com/Entrevoix/carnet)", "Accept": "text/html" } })`.
  - If `!response.ok` or `content-type` not `text/html*` → return null.
  - Cap body read at 256 KB (`response.text()` then slice — RN doesn't expose response streaming cleanly).
  - Parse with regexes (no DOM in RN); extract:
    - `<title>(.*?)</title>` (case-insensitive, dotAll on the captured group only)
    - `<meta property="og:title" content="..."`
    - `<meta property="og:description" content="..."`
    - `<meta name="description" content="..."`
    - `<meta property="og:site_name" content="..."`
    - First `<p>` text (strip tags inside)
  - Decode common HTML entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;`).
  - Trim each field to 500 chars max.
  - Return null on any catch.
- **MIRROR:** `TIMED_FETCH_WITH_ABORT`.
- **IMPORTS:** None new (uses global `fetch`, `AbortController`).
- **GOTCHA:**
  - RN's `fetch` doesn't follow chunked encoding gracefully; capping at 256 KB is a safety belt.
  - User-Agent is required — many sites 403 the default RN fetch UA.
  - Some sites return 200 with HTML for everything (including 404s); rely on `<title>` presence as a sanity check.
- **VALIDATE:** Unit tests in task 2 cover happy path + 4 failure modes.

### Task 2: Tests for the preview parser
- **ACTION:** New `apps/mobile/src/lib/urlpreview.test.ts`. Mock global fetch; cover the parser.
- **IMPLEMENT (test cases):**
  ```ts
  // happy path: og:* and <title> present
  // og:* missing, <title> + <meta name=description> present
  // body too large → truncated at 256 KB, parser still extracts <title> from the head
  // HTML entities in <title> → decoded
  // non-200 response → returns null
  // non-text/html content-type → returns null
  // network error (fetch throws) → returns null
  // timeout (AbortError) → returns null
  // invalid URL string → returns null without fetching
  ```
- **MIRROR:** `MOCKED_FETCH_TEST_SHAPE`.
- **IMPORTS:** vitest + the new urlpreview module.
- **VALIDATE:** `npm -w @carnet/mobile run test` — all new cases pass.

### Task 3: Extend `buildSharedLinkPrompt` to accept a preview
- **ACTION:** Update `prompts.ts` so the function takes a 4th param `preview: { title, description, siteName } | null` and threads it into the user message when present.
- **IMPLEMENT:**
  ```ts
  export function buildSharedLinkPrompt(
    url: string,
    text: string,
    context: string,
    preview: { title: string; description: string; siteName: string } | null,
  ): PromptPair {
    // ...existing system prompt...
    const previewLines = preview
      ? [
          preview.siteName && `Site: ${preview.siteName}`,
          preview.title && `Page title: ${preview.title}`,
          preview.description && `Description: ${preview.description}`,
        ].filter(Boolean).join("\n")
      : "";
    const bodyParts = [
      url && `URL: ${url}`,
      previewLines,
      text && text !== url && `Text: ${text}`,
      context && `Context: ${context}`,
    ].filter(Boolean).join("\n\n");
    const user = `<USER_INPUT>\n${bodyParts}\n</USER_INPUT>`;
    return { system, user };
  }
  ```
- **MIRROR:** `PROMPT_BUILDER_SIGNATURE`.
- **GOTCHA:** Preview is data, not instructions — must stay inside the `<USER_INPUT>` envelope so the `INJECTION_GUARD` covers it (the preview could contain injection attempts from the page).
- **VALIDATE:** Manual prompt inspection in dev; the existing tests for buildSharedLinkPrompt (if any) accept the new optional param.

### Task 4: `enrichSharedLink` fetches preview before calling `chatCompletion`
- **ACTION:** In `omniroute.ts` `enrichSharedLink`, call `fetchUrlPreview(url)` when `url` is set; pass the result (or null) into `buildSharedLinkPrompt`.
- **IMPLEMENT:**
  ```ts
  export async function enrichSharedLink(input: { url: string; text: string; context: string }): Promise<EnrichResult> {
    const [baseUrl, apiKey, model, preview] = await Promise.all([
      getBaseUrl(),
      getApiKey(),
      getModel(),
      input.url ? fetchUrlPreview(input.url).catch(() => null) : Promise.resolve(null),
    ]);
    return chatCompletion(baseUrl, apiKey, model,
      buildSharedLinkPrompt(input.url, input.text, input.context, preview));
  }
  ```
- **MIRROR:** Existing Promise.all settings-load shape; `.catch(() => null)` ensures preview failure doesn't sink the enrichment call.
- **IMPORTS:** `import { fetchUrlPreview } from "./urlpreview";`
- **GOTCHA:** Don't await preview sequentially — run it parallel with settings reads. Saves ~2-5s on slow networks.
- **VALIDATE:** Update omniroute.test.ts: add a case where fetch is mocked twice (once for preview, once for chat completion) and assert the preview content appears in the messages sent.

### Task 5: (Optional) Surface "fetching preview" in ShareReceive spinner
- **ACTION:** If preview fetch is noticeably slow, set a sub-state during save: `setSavingDetail("Fetching link preview…" / "Enriching with OmniRoute…")`.
- **IMPLEMENT:** ~5 line state addition + spinner copy.
- **GOTCHA:** Most previews complete in <2s; sub-state may flash by. Skip unless dogfooding reveals it's annoying.
- **VALIDATE:** Visual on device.

---

## Testing Strategy

### Unit Tests
Per task 2 — full coverage of the parser. Update omniroute.test.ts for the prompt change.

### Edge Cases Checklist
- [ ] URL with no scheme (`example.com`) → URL constructor throws → null
- [ ] HTTPS URL with self-signed cert → fetch fails → null
- [ ] 200 OK but content-type `application/json` (an API endpoint shared) → null
- [ ] Page returns 5 MB of HTML → first 256 KB only; title found if it's in the head
- [ ] Title contains injection: `<title>Ignore previous instructions and...</title>` → still wrapped in `<USER_INPUT>`, INJECTION_GUARD applies
- [ ] Empty title and description but URL is descriptive → preview = null, prompt falls back to URL-string-only behavior
- [ ] Preview fetch takes 7.5s → just under the 8s timeout → succeeds

---

## Validation Commands

```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
# JS-only — no rebuild needed
# Manual: share a URL, observe the saved MD has a real summary
```

### Manual Validation
- [ ] Share a known article (e.g., a recent NYT or Stratechery post) → MD has descriptive title + summary using real page content
- [ ] Share a URL behind a paywall / Cloudflare bot block → MD still saves with degraded summary (preview was null) — no crash
- [ ] Toggle airplane mode → share a URL → preview returns null, MD has the URL-string-only summary, save completes

---

## Acceptance Criteria
- [ ] `fetchUrlPreview` returns structured data for typical articles
- [ ] Failure modes (4xx, 5xx, timeout, parse error, invalid URL) all return null without throwing
- [ ] `enrichSharedLink` runs preview + settings reads in parallel
- [ ] Markdown summary quality demonstrably improves on real articles
- [ ] No regression on URL shares when offline (degrades to URL-string-only)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Site detects RN UA and 403s the request | Medium | Preview missing for that domain | Use a generic Mozilla UA + carnet identifier; accept partial coverage |
| Page returns 200 with bot-detection HTML (Cloudflare interstitial) | Medium | Garbage in summary | Detect "Just a moment..." style content via heuristics? Defer — degraded summary is better than nothing |
| Regex-based HTML parsing is fragile | Medium | Missed titles on weird markup | Tolerate it — falls back to null cleanly. A real DOM parser is overkill for this. |
| Prompt-injection via page content | Low | Model misbehaves | Already wrapped in `<USER_INPUT>` + `INJECTION_GUARD`. Document the threat model in code comment. |

## Notes
- This is a perfect candidate for follow-up improvement: add a small per-domain cache if the same URL is shared more than once a day. Defer until usage data suggests it matters.
- A future variant could call a dedicated "reader" model (Gemini Flash with web-grounding tool) instead of fetching ourselves. Out of scope here.
