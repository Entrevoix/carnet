# Assumptions and Unresolved Decisions

## Assumptions

- Phase 1 runs on Node 20+ on a filesystem supporting atomic same-directory rename/link.
- One knowledge base is a trust domain; processors may read PII within it.
- Capture clocks can be wrong, so ids establish uniqueness while timestamps remain observed
  metadata.
- Phone normalization without a country signal is deliberately incomplete.
- Exact identifier matches may associate an interaction with an existing contact, but never
  merge or rewrite that contact automatically.
- Full-text search is a small, rebuildable JSON inverted index suitable for initial scale.

## Unresolved

- Whether schema-v1 mobile output dual-writes alongside current `People/` notes or replaces
  server-generated person notes after a compatibility window.
- Attachment/file size limits and retention policy before a network upload adapter ships.
- Event identity policy when only a name and partial date are known.
- Whether contact creation for a low-scoring capture should be automatic or always begin as
  a candidate/review record in stricter deployments.
- Locale/country sources for phone normalization.
- Review approval semantics for applying proposed changes and rollback history.
- Filesystem portability for platforms without hard links; a replace-safe fallback needs an
  explicit durability analysis.
- Full-text index scaling threshold and future SQLite/FTS or external search adapter. Any
  index remains disposable and rebuildable.
- Authentication, authorization, rate limits, and encrypted storage for Phase 3 APIs.
