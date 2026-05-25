# Implementation Report: Audio transcription via OmniRoute Whisper (slate #4 part 2)

## Summary
On-demand audio transcription is live. New `transcribeAudio` function in `omniroute.ts` posts to OpenAI-compatible `/v1/audio/transcriptions` (multipart/form-data with file + model). New idempotent `upsertSection` helper in `writer.ts` insert-or-replaces an H2 section in a markdown body. RecentDetail gets a Transcribe button gated on `kind: shared-audio` that wires the two together — reads the paired `.m4a`, transcribes via Whisper, writes a `## Transcript` section into the existing note. Re-runs replace in place. New Settings field `omniRouteTranscriptionModel` (default `whisper-1`) keeps transcription model independent of chat model.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | 9/10 — landed clean, exceeded expectations |
| Files Changed | 5 source + 2 tests | 5 source + 2 tests |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Add transcription model field to Settings | Complete | Spread-based migration handles existing v2 blobs |
| 2 | Add Transcription model TextInput to SettingsScreen | Complete | No Browse button (Whisper models aren't in chat catalog) |
| 3 | Add transcribeAudio + cap + getTranscriptionModel to omniroute.ts | Complete | 25 MB pre-flight cap, HTTPS guard, sanitized errors |
| 4 | Add upsertSection helper to writer.ts | Complete | Pure function — easy to test, easy to reuse |
| 5 | Wire Transcribe button in RecentDetailScreen | Complete | Linter reverted edits once; re-applied successfully |
| 6 | Tests: upsertSection + transcribeAudio | Complete | 10 upsertSection cases + 9 transcribeAudio cases |
| 7 | Final typecheck + tests | Complete | 0 errors, 189/189 tests pass |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean |
| Unit Tests | Pass | 189/189 (was 170; +19 new across writer + omniroute) |
| Build | N/A | JS-only changes; live-reloads on dev client |
| Integration | N/A | Requires on-device + live OmniRoute instance |
| Edge Cases | Pass | Covered by unit tests (size cap, HTTPS guard, empty transcript, auth fail, model fallback) |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/lib/omniroute.ts` | UPDATED | +114 / -0 |
| `apps/mobile/src/lib/settings.ts` | UPDATED | +13 / -0 |
| `apps/mobile/src/lib/writer.ts` | UPDATED | +47 / -0 |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATED | +20 / -1 |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATED | +60 / -4 |
| `apps/mobile/src/lib/writer.test.ts` | UPDATED | +90 / -0 (10 new tests) |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATED | +175 / -0 (9 new tests + fixture updates) |

## Deviations from Plan
**None of substance.** One mechanical bump: the linter reverted RecentDetailScreen edits once mid-stream (file-state-changed error), requiring a re-read + re-apply. Same false-alarm pattern documented in past sessions. Final state matches the plan exactly.

## Issues Encountered
- **Linter file-state cascade on RecentDetailScreen.tsx** — When Tasks 5 + 6 ran in parallel, RecentDetailScreen's parallel edits raced with a linter pass that rewrote the file from disk, invalidating my in-context view. Resolved by re-reading + re-applying. No code lost.
- **Stray `});` after writer.test.ts upsertSection block** — My append edit included a closing `});` that doubled the existing close of the readPairedBinaryFromNote describe. Caught immediately by the typecheck signal, fixed in one edit.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `apps/mobile/src/lib/writer.test.ts` | 10 (upsertSection) | append, replace-EOF, replace-with-following-H2, replace-with-following-H1, trailing-whitespace strict match, frontmatter preservation, idempotency, H3 boundary handling, no-trailing-newline append, normalize-trailing-newlines append |
| `apps/mobile/src/lib/omniroute.test.ts` | 9 (transcribeAudio) | happy path, whitespace trim, 401 auth, 413 payload-from-server, empty transcript, 25 MB pre-flight cap, HTTPS guard, model fallback when empty, MAX_TRANSCRIPTION_BYTES constant |

## On-Device Validation Checklist
- [ ] Settings → new "Transcription model" field appears below "Model", defaults to `whisper-1`
- [ ] Save Settings → reopen → transcription model persists
- [ ] Record an audio note (or share one) → tap recent → Transcribe button appears
- [ ] Tap Transcribe → "Transcribing audio…" spinner → text appears under `## Transcript` in the rendered markdown
- [ ] Tap Transcribe again → transcript replaced in place, no duplicate section
- [ ] Tap Transcribe with wrong API key → "Transcribe failed: ... 401 ..." banner with Bearer redacted
- [ ] Transcribe a >25 MB recording → 413 banner before any network round-trip
- [ ] Open the .md in a desktop editor → YAML frontmatter, file link, context, and transcript sections in expected order

## Next Steps
- [ ] On-device QA against checklist above
- [ ] `/prp-commit` (this branch only — no orphans to clean up)
- [ ] `/prp-pr`
- [ ] Slate #4 fully shipped after this merges. Optional follow-ups: auto-transcribe at save time (3-line addition + new setting flag); "Polish transcript" button (second LLM pass to add punctuation + summary).
