# Schema Migration Strategy

Every record carries `schema_version`. Version 1 readers reject unsupported versions rather
than guessing. Migrations are explicit, deterministic programs with source and destination
schemas.

Rules:

1. Never migrate the only copy in place. Write a sibling candidate or a new knowledge-base
   tree atomically, validate it, then switch after review.
2. Preserve immutable ids, source capture ids, provenance, bodies, unknown evidence, and
   original attachments.
3. Record the migration processor/version and old content hash in provenance or a processing
   job.
4. Make migrations idempotent and restartable using source revision plus migration version.
5. Support at least one prior schema version in a dedicated migration command, not in every
   normal processor.
6. Treat lossy transformations as proposed changes requiring review.
7. Golden fixtures pin rendered output for each supported version.

Future schema packages should use immutable `$id` URLs containing the major version rather
than changing the meaning of the current v1 files.
