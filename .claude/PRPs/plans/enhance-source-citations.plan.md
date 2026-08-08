# Plan: Link Enhance's citations instead of deleting them

Status: draft

## Summary
`sonar-reasoning-pro` cites its facts with inline markers (`[1]`, `[8]`) and
returns the matching URLs in a separate `annotations` field. The gateway drops
that field when assembling the non-streaming response, so Carnet currently
receives markers pointing at nothing and strips them. This plan restores them as
real links — a `## Sources` block — once the gateway passes annotations through.

**This plan is BLOCKED on a change in the OmniRoute repo.** The gateway work is
specified here as a prerequisite; the Carnet work is planned in full and is
small once the field arrives.

## User Story
As someone whose journal gets enriched with facts I did not write,
I want to see where each fact came from,
So that I can check a claim, and tell my own knowledge from the model's.

## Problem → Solution
Facts are added with no provenance, and the prompt itself admits the author
"will not be able to tell later which details came from you" → every added fact
traces to a source the author can open.

## Metadata
- **Complexity**: Small (Carnet side) — gated on an external Medium change
- **Estimated Files**: 5 in Carnet
- **Blocked by**: gateway annotation passthrough (see Prerequisite)

---

## Prerequisite — the gateway change (different repo)

### Evidence, gathered 2026-08-08 against `llm.grepon.cc`

Same model, same prompt, two request shapes:

| Request | `annotations` present? |
|---|---|
| `{"stream": true, ...}` | **YES** — 5 sources with URLs + titles |
| `{"stream": false, ...}` | **NO** — response keys are `['id','object','created','model','choices','usage']`, message keys `['role','refusal','content','reasoning']` |

Streaming delta payload, verbatim:

```json
{ "type": "url_citation",
  "url_citation": {
    "url": "https://en.wikipedia.org/wiki/Stroudsburg,_Pennsylvania",
    "title": "Stroudsburg, Pennsylvania - Wikipedia",
    "start_index": 0, "end_index": 0 } }
```

The upstream provider returns citations. The gateway receives them and discards
them while normalizing to the non-streaming OpenAI shape. **That is data loss in
the gateway, not a limitation of the model or of Carnet.**

### What the gateway must do

Include the accumulated annotations on the assembled non-streaming response, at
the OpenAI-standard location:

```
choices[0].message.annotations: Array<{
  type: "url_citation",
  url_citation: { url: string, title: string, start_index: number, end_index: number }
}>
```

Notes for whoever implements it:
- `start_index`/`end_index` arrive as `0` from this provider. Pass them through
  unchanged; do not synthesize offsets. Carnet maps markers by **ordinal**
  (`[1]` → first annotation), which is the Perplexity convention.
- Deduplicate by URL if the stream repeats one, preserving first-seen order —
  ordinal mapping depends on order being stable.
- Absent for models that do not cite. Carnet treats missing/empty as "no
  sources" and must not error.

### Why not solve it in Carnet instead

Carnet could stream and accumulate the deltas itself. It should not:
`llmClient.ts:303` already documents that an SSE body **hangs**
`await response.json()` because it never closes into a parseable document, and
React Native's `fetch` does not expose a readable response body — consuming SSE
would mean routing Enhance through XHR progress events, the same workaround this
repo already needed for Karakeep multipart. That is a large change to the most
fragile layer in the stack, to recover data the gateway already has in hand.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/llmClient.ts` | 340-370 | Where the response is parsed; `json.choices?.[0]?.message?.content` |
| P0 | `apps/mobile/src/lib/enhanceProse.ts` | 157-185 | `stripCitationMarkers` — the stopgap this plan retires |
| P0 | `apps/mobile/src/lib/enhanceProse.ts` | 239-251 | The `## Links` backstop — the block-append pattern to mirror |
| P1 | `apps/mobile/src/lib/llmClient.ts` | 110-120 | `OpenAIChoice` / `OpenAIResponse` types to extend |
| P1 | `apps/mobile/src/lib/llmClient.ts` | *(EnrichResult)* | `{ markdown, model }` — needs a `sources` field |

---

## Patterns to Mirror

### RESPONSE_PARSE
```ts
// SOURCE: apps/mobile/src/lib/llmClient.ts:354-355
const json = (await response.json()) as OpenAIResponse;
const content = json.choices?.[0]?.message?.content;
```

### APPENDED_BLOCK  ← the shape a Sources block should take
```ts
// SOURCE: apps/mobile/src/lib/enhanceProse.ts:243-245
const lost = droppedUrls(rest, cleaned);
const linkBlock =
  lost.length > 0 ? `\n\n## Links\n${lost.map((u) => `- <${u}>`).join("\n")}` : "";
```

### NEVER_THROWS
```ts
// SOURCE: apps/mobile/src/lib/enhanceProse.ts (outcome contract)
// Every failure path returns { kind: "failed", reason } — never throws.
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/llmClient.ts` | UPDATE | Extend the response type; surface `annotations` on `EnrichResult` |
| `apps/mobile/src/lib/llmClient.test.ts` | UPDATE | Parse coverage, incl. absent/empty |
| `apps/mobile/src/lib/enhanceProse.ts` | UPDATE | Render `## Sources`; retire the strip |
| `apps/mobile/src/lib/enhanceProse.test.ts` | UPDATE | Ordinal mapping, absent-annotations, marker retention |
| `apps/mobile/src/lib/dispatcher.ts` | UPDATE | Thread the new field through if it re-shapes `EnrichResult` |

## NOT Building

- **No streaming in Carnet.** See "Why not solve it in Carnet instead."
- **No offset-based marker rewriting.** The provider zeroes the indices;
  ordinal mapping only.
- **No source fetching, caching, or link previews.** Render what the gateway
  reports; do not go to the network.
- **No change to capture enrichment.** Enhance only, matching the earlier scope
  decision.
- **No footnote syntax in the note body.** Obsidian's `[^1]` renders, but
  rewriting `[1]` → `[^1]` edits the model's text; keep markers as-is and put
  the mapping in the Sources block.

---

## Step-by-Step Tasks

### Task 1: Type the annotations
- **ACTION**: Extend the response types to carry `message.annotations`.
- **IMPLEMENT**: `interface UrlCitation { url: string; title: string }` and
  `annotations?: Array<{ type: string; url_citation?: UrlCitation }>` on the
  message type.
- **MIRROR**: RESPONSE_PARSE.
- **GOTCHA**: Every field is optional. A model that does not cite omits the key
  entirely; a gateway mid-rollout may send `[]`. Both mean "no sources".
- **VALIDATE**: `tsc --noEmit` clean; a test parses a response with and without.

### Task 2: Surface sources on `EnrichResult`
- **ACTION**: Add `sources?: Array<{ url: string; title: string }>`.
- **IMPLEMENT**: Populate from `json.choices[0].message.annotations`, filtering
  to `type === "url_citation"`, deduping by URL, preserving first-seen order.
- **GOTCHA**: Order is the ordinal contract — do not sort.
- **VALIDATE**: dedupe and order pinned by test.

### Task 3: Render the Sources block
- **ACTION**: Append `## Sources` when sources are present.
- **IMPLEMENT**: `\n\n## Sources\n1. [title](url)\n2. …`, numbered so the
  ordinal lines up with the inline `[N]` markers.
- **MIRROR**: APPENDED_BLOCK.
- **GOTCHA**: Place it AFTER the `## Links` backstop block so a note that
  triggers both keeps a stable order. Sources is model provenance; Links is
  recovery of the author's own dropped links — do not merge them.
- **VALIDATE**: a note with 3 markers and 3 annotations renders 3 numbered rows.

### Task 4: Retire `stripCitationMarkers`
- **ACTION**: Stop stripping when sources are available.
- **IMPLEMENT**: Keep the function and call it ONLY when `sources` is
  empty/absent — a model that emits markers without annotations still produces
  dangling references, which is exactly today's situation.
- **GOTCHA**: Do not delete it outright. The gateway change may roll out per
  model, and Relais/other providers will never send annotations.
- **VALIDATE**: markers survive when sources exist; are stripped when not.

### Task 5: Frontmatter provenance (decide before building)
- **ACTION**: Consider recording source URLs in frontmatter as well as the body.
- **OPEN QUESTION — do not guess.** Body-only keeps the note portable and is
  what Obsidian renders; frontmatter makes sources queryable via Dataview but
  grows a structural field this feature has so far promised not to add
  (`stampProvenance` deliberately refuses to create frontmatter that was not
  already there). Ask before implementing.

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| parses annotations | response with 3 url_citations | 3 sources, order preserved | no |
| absent key | no `annotations` | `sources` undefined, no throw | yes |
| empty array | `annotations: []` | treated as no sources | yes |
| non-citation type | mixed types | only `url_citation` kept | yes |
| duplicate URL | same URL twice | deduped, first-seen order | yes |
| renders block | 2 sources | `## Sources` with 2 numbered links | no |
| markers retained | sources present | `[1]` still in the prose | yes |
| markers stripped | no sources | current strip behaviour | yes |
| both blocks | dropped link + sources | `## Links` then `## Sources` | yes |

---

## Validation Commands

```bash
npm run build:shared && npm -w @carnet/mobile run typecheck   # zero errors
npm -w @carnet/mobile test -- enhanceProse llmClient          # all pass
npm -w @carnet/mobile test                                     # no regressions
npm -w @carnet/mobile run lint                                 # clean
npm -w @carnet/mobile run verify:capture-flow                  # 272/272
```

### Manual Validation
- [ ] Enhance a note naming a town → facts added, `[1]`-style markers retained
- [ ] A `## Sources` block lists each marker's title as a tappable link
- [ ] Marker ordinal matches the numbered source
- [ ] A note with nothing to enrich returns unchanged, no empty Sources block
- [ ] Enhance against a NON-citing model (e.g. gemini) → no Sources block, no
      dangling markers

---

## Acceptance Criteria
- [ ] Gateway prerequisite shipped and verified with a live `stream:false` call
- [ ] Every task complete, all validation commands pass
- [ ] Markers retained when resolvable, stripped when not
- [ ] No type errors, no lint errors

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gateway change never ships | Medium | Plan stays blocked | Stopgap strip already merged; today's behaviour is acceptable |
| Ordinal mapping wrong | Medium | Wrong source attributed to a fact | Order-preservation test; indices are zeroed so ordinal is the only option — verify on a real multi-source entry |
| Partial rollout | Medium | Some models cite, some do not | Task 4 keeps the strip as the fallback path |
| Sources block bloats short notes | Low | Cosmetic | Only renders when sources exist |

## Notes
- The `## Sources` block is the concrete answer to prompt rule 4's own warning:
  *"this is a permanent personal record, and the author will not be able to tell
  later which details came from you."* Provenance is the point, not decoration.
- Confirmed working on-device before this plan was written: `sonar-reasoning-pro`
  enriched using the photo, location metadata AND the words of the entry.
  Citations are the missing half of an otherwise-correct feature.
