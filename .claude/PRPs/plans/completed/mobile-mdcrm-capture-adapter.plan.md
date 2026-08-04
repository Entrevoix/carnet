# PR plan: Mobile schema-v1 card-capture adapter

Status: shipped

## Goal

Add an additive mobile writer for schema-v1 `mdcrm` business-card capture packages. It must
preserve the original card image and raw OCR sidecar locally while leaving the existing
`People/` note output and confirmation flow unchanged.

## Scope

- Generate cryptographically random, immutable prefixed ULIDs on-device.
- Save card originals to `attachments/originals/`, raw OCR to `processing/results/`, and a
  capture record to `captures/` beneath the selected Carnet vault root.
- Hash the original image bytes and write relative attachment/OCR references valid for
  `@carnet/mdcrm` validation and processing.
- Wire the card scanner to create the package independently of the existing person-note
  enrichment, with a graceful OCR-failure path that retains the image.
- Cover pure package rendering and writer integration with unit tests; run the mobile and
  mdcrm suites.

## Boundaries

- No contact merging, event matching, LLM enrichment, server upload, or review UI on mobile.
- Existing `People/` frontmatter is not changed or reinterpreted.
- The Expo SAF API has no portable atomic rename primitive. The adapter therefore uses the
  existing collision-safe vault write seam and records this limitation; server-side writes
  remain atomic.
