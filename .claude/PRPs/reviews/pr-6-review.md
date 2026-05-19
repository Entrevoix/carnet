# PR Review: #6 — feat: fetch URL preview before enriching shared links

**Reviewed**: 2026-05-18
**Author**: @bearyjd
**Branch**: feat/url-share-preview-fetch → main
**Decision**: APPROVE with comments

## Summary
Solid implementation that matches the plan exactly. New module is well-scoped, never-throws contract is honored cleanly, tests cover the failure surface comprehensively, and the prompt threading preserves the existing INJECTION_GUARD boundary. Six LOW-severity nits surfaced — none blocking, mostly future-polish.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM
None.

### LOW

**[L1] `decodeEntities` can throw `RangeError` on numeric entities above U+10FFFF**
File: `apps/mobile/src/lib/urlpreview.ts:55-69`
`String.fromCodePoint(n)` throws `RangeError` for `n > 0x10FFFF`. The `Number.isFinite(n)` guard accepts any finite number including out-of-range code points. Caught by the outer try in `fetchUrlPreview` → returns null instead of partial decode.
Fix (optional): change guard to `Number.isFinite(n) && n <= 0x10FFFF` so a single hostile `&#1114112;` doesn't nuke the whole preview.

**[L2] `MAX_BODY_BYTES` is enforced in characters, not bytes**
File: `apps/mobile/src/lib/urlpreview.ts:33,166`
`body.slice(0, MAX_BODY_BYTES)` counts UTF-16 code units. A page composed largely of multibyte glyphs could occupy ~2x the labelled budget. The JSDoc says "256 KB body cap" but the implementation caps at 256K *characters*.
Fix (optional): either rename the constant to `MAX_BODY_CHARS` to match the actual unit, or convert via `TextEncoder` (not free in RN).

**[L3] `metaContent` regex accepts mismatched quote pairs**
File: `apps/mobile/src/lib/urlpreview.ts:84-99`
The pattern `["']${escaped}["']` doesn't backreference the opening quote, so `content="foo'` (open `"`, close `'`) would match. Implausible in real HTML, harmless if it slips through.
Fix (optional): use `(["'])([^"']*)\1` with a captured backreference.

**[L4] SSRF surface from device's network position**
File: `apps/mobile/src/lib/urlpreview.ts:142-184`
A shared URL is fetched from the device, so any network the device can reach (incl. private LAN / VPN-tunneled internal services / `192.168.*` / `10.*`) is reachable through `fetchUrlPreview`. Threat requires an attacker to get the user to share a malicious URL AND to know an internal target. The OmniRoute API key is never leaked (preview fetch uses the URL only). Acceptable for a personal capture tool but worth documenting.
Fix (optional): block private-IP / loopback hosts after URL parse if the threat model warrants it. Tradeoff: blocks legitimate self-hosted bookmarking.

**[L5] System-prompt fallback test is coupled to exact wording**
File: `apps/mobile/src/lib/omniroute.test.ts` (preview-fallback case)
`expect(systemContent).toMatch(/do NOT have the page contents/i)` will break on any rewording of the fallback branch. The behavior under test (preview-failure falls back to URL-string-only) is right; the assertion shape is brittle.
Fix (optional): assert on the absence of preview lines in the user content (already done) and drop the system-prompt content assertion, OR assert on a more stable signal like the *absence* of "primary source" wording.

**[L6] Preview adds up to 8s to the user-perceived save latency**
File: `apps/mobile/src/lib/omniroute.ts:391-396`
Preview runs in parallel with settings reads (cheap) but sequentially before chat completion (5-60s). On a slow site, total wait can grow to ~13s. The plan explicitly accepted this trade-off. The skipped Task 5 (sub-state spinner copy) becomes relevant if real-world dogfooding shows the dead-air feels noticeable.
Fix (optional): if dogfooding surfaces complaints, add a "Fetching preview…" → "Enriching…" sub-state.

## Category Coverage

| Category | Verdict |
|---|---|
| Correctness | Sound. The regex bug from initial implementation was caught by tests and fixed. |
| Type Safety | All explicit. No `any`. `SharedLinkPreview` interface is structurally compatible with `UrlPreview` so the integration works without an adapter. |
| Pattern Compliance | Matches project conventions: `lib/*.ts` + matching `*.test.ts`, fetch-with-AbortController mirrors `omniroute.ts`, prompt builder shape mirrors the other builders, JSDoc on every exported symbol. |
| Security | URL scheme allowlisted (http/https only). Preview content threaded through `<USER_INPUT>` envelope — INJECTION_GUARD covers it. API key never sent to scraped sites. SSRF surface noted in L4. |
| Performance | 8s preview cap prevents tail-latency disasters. 256 KB body cap prevents OOM. Parallel `Promise.all` with settings reads is correct. Trade-off in L6. |
| Completeness | 15 parser tests + 4 integration tests cover the documented edge-case checklist from the plan. No regressions in the 74 pre-existing tests. |
| Maintainability | Helpers extracted, magic numbers named with JSDoc. Threat-model comment present. Plan archived + report written. |

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass — zero errors |
| Lint | Skipped — no lint script in `apps/mobile/package.json` |
| Tests (`vitest run`) | Pass — 93/93 (was 74; +15 parser, +4 integration) |
| Build | Skipped — JS-only, no native rebuild needed |
| CI (GitHub Actions) | All 4 jobs green: shared / mobile / desktop / gate |

## Files Reviewed

| File | Change |
|---|---|
| `apps/mobile/src/lib/urlpreview.ts` | Added |
| `apps/mobile/src/lib/urlpreview.test.ts` | Added |
| `apps/mobile/src/lib/prompts.ts` | Modified |
| `apps/mobile/src/lib/omniroute.ts` | Modified |
| `apps/mobile/src/lib/omniroute.test.ts` | Modified |
| `.claude/PRPs/plans/completed/url-share-preview-fetch.plan.md` | Added (archive) |
| `.claude/PRPs/reports/url-share-preview-fetch-report.md` | Added |

## Decision: APPROVE with comments
No CRITICAL or HIGH findings. CI green. Local validation green. Implementation matches the plan and respects the project's prompt-injection boundary. The six LOW items are documented for future polish; none should block merge. Recommend merging once on-device validation is done (share an article, share a paywalled URL, share offline).
