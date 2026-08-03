# Carnet Mobile Migration Boundary

## Current output

Carnet v0.2 writes human-oriented Obsidian notes:

- `People/First-Last.md` with flat person frontmatter generated after card OCR/enrichment.
- `Ideas/slug.md`, including save-first raw notes updated after enrichment.
- `Journal/YYYY-MM-DD.md`, with multiple daily entries appended to one file.
- Images and arbitrary attachments under `Photos/` and `Attachments/`.

These files have byte-compatibility and user-edit safety constraints. They lack immutable
record ids, attachment hashes, raw OCR sidecars, provenance objects, and capture revisions.

## Smallest migration path

1. Ship the server against schema-v1 capture packages without changing existing mobile notes.
2. The mobile card scanner now writes an additive package beside the existing writer:
   `attachments/originals/att_*.jpg`, `processing/results/cap_*.ocr.txt`, and
   `captures/cap_*.md`. It uses a CSPRNG ULID and hashes decoded image bytes. OCR failure
   retains the image and an empty raw-OCR sidecar for manual entry or later processing.
3. Keep producing the existing `People/` note during a compatibility window, or let the
   server create the new contact candidate. Never reinterpret old notes silently.
4. Add an explicit `mdcrm import-carnet-legacy` command later for users who want to map
   selected legacy notes into captures. Imported values are `observed` only when directly
   represented; LLM-authored prose is not promoted to confirmed fact.
5. Once dual-write has proven reliable, make capture packages the interchange output while
   retaining the current notes as a human-readable view if desired.

The Expo Storage Access Framework does not expose a portable atomic rename, so mobile uses
the existing collision-safe new-file writer. The server remains responsible for its stronger
atomic rewrite and optimistic-concurrency guarantees.

## Capture-side normalization

Safe on-device: whitespace/Unicode normalization, lowercase email, deterministic phone/date/
URL normalization when unambiguous, hashes, ids, timestamps, and raw OCR preservation.

Server-only: merging, fuzzy identity decisions, company/event resolution, relationship
strength, sensitive inference, LLM summaries, task/follow-up suggestions, and canonical
contact mutation.
