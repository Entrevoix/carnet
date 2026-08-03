# PR plan: Markdown contact and event processing system

Status: in-progress

## Outcome

Add an independently deployable `@carnet/mdcrm` Node.js workspace that consumes and
produces versioned Markdown records. Carnet mobile remains local-first and unchanged in
this PR; an explicit adapter/migration boundary maps its existing `People/`, `Ideas/`, and
`Journal/` notes into the new capture schema later without rewriting working capture code.

## Architecture decisions

- Markdown plus attachments are canonical; indexes, locks, and job state are derived.
- The filesystem adapter is the first transport and storage implementation.
- Processors are deterministic, separately callable, idempotent, and LLM-free in Phase 1.
- Canonical source records are never overwritten by uncertain inference. Review items and
  derived records carry suggestions.
- Atomic writes use a same-directory temporary file, file sync, validation, then rename.
- Optimistic concurrency uses content SHA-256 revisions. A changed source produces a review
  conflict rather than a blind rewrite.
- ULIDs back immutable ids. Filenames remain readable but are never relationship keys.
- JSON Schema describes every Phase 1 record and validates frontmatter at the boundary.

## Current mobile output and migration boundary

Carnet currently writes `Ideas/{slug}.md`, `Journal/YYYY-MM-DD.md`, and
`People/{First-Last}.md`; person fields are flat (`name`, `company`, `title`, `email`,
`phone`, `linkedin`, `met`, `where`, `tags`). Card OCR currently flows through a configured
vision provider and neither the card original nor raw OCR is guaranteed to be retained.

This PR does not mutate that byte-sensitive frontmatter or mobile writer. The server accepts
new schema-v1 capture packages under `captures/`; a later mobile adapter can dual-write those
packages after original-image/raw-OCR preservation is implemented. Legacy import is a
separate, explicit command so existing notes never silently change meaning.

## Implementation sequence

1. Architecture, repository layout, schema contract, migration notes, threat model.
2. Workspace scaffold, configuration, ids, Markdown/YAML parsing, JSON Schema registry.
3. Atomic filesystem repository, attachment integrity checks, discovery, locks/leases.
4. Normalization, exact matching, deterministic score calculation, review generation.
5. Capture pipeline creating contact/organization/event/interaction/job outputs safely.
6. Full-text derived index and composable CLI with JSON output and meaningful exit codes.
7. Golden fixtures plus unit and integration tests, including repeat processing and failures.

## Acceptance criteria

- Capture, contact, organization, event, interaction, task, review item, processing job, and
  proposed change schemas exist and are validated.
- Re-running an unchanged capture does not duplicate derived records.
- Exact email/phone matching is deterministic; ambiguous candidates become review items.
- Original captures are not destructively rewritten by the pipeline.
- Indexes can be deleted and rebuilt from Markdown.
- The server works with all LLM features disabled and has no dependency on mobile internals.

## Deferred

- Mobile schema-v1 dual-write and original card-image/raw-OCR UX.
- Enhanced OCR, LLM extraction, embeddings, review UI, remote transport adapters, calendar,
  email, and CRM/vCard exports.
