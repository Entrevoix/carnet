# Markdown Contact and Event Architecture

## Boundary

`@carnet/mdcrm` is a standalone Node.js program. It knows nothing about React Native,
AsyncStorage, SecureStore, or Carnet's in-process APIs. Its only integration boundary is a
knowledge-base directory containing Markdown, YAML frontmatter, attachments, and optional
sidecars.

Carnet mobile remains usable without this program. Sync can be Syncthing today and another
transport later; transport does not alter record schemas.

```text
Carnet / another capture tool
  -> atomic local capture package
  -> transport adapter (outside the schema)
  -> knowledge-base/captures + attachments
  -> discover -> validate -> lease -> normalize -> match -> derive -> index
  -> contacts / organizations / events / interactions / review / jobs
```

## Repository layout

```text
apps/mdcrm/
  src/
    cli/             command dispatch and output contracts
    config/          YAML configuration and environment overrides
    schemas/         JSON Schema registry
    markdown/        parser, deterministic writer, links
    models/          TypeScript record contracts and state vocabulary
    normalization/   deterministic field normalization
    matching/        exact lookup and configurable candidate scoring
    processors/      validation and capture pipeline stages
    storage/         filesystem repository, atomic writes, leases
    indexing/        rebuildable full-text JSON index
    review/          review-item construction
    jobs/            processing-job and idempotency helpers
  schemas/           distributable JSON Schema files
  fixtures/          golden knowledge bases
  test/              integration tests
  mdcrm.example.yaml
  README.md
```

## Runtime knowledge-base layout

```text
knowledge-base/
  inbox/{pending,processing,review,completed,failed}/
  captures/ contacts/ organizations/ events/ interactions/ tasks/
  attachments/{originals,derived,thumbnails}/
  processing/{results,errors,locks,jobs}/
  review/
  indexes/
  schemas/
```

Files do not need to move as status changes. The filesystem adapter leaves records in place
and uses `processing.state`; moving inbox files is a future configurable policy.

## Processor contract

Each processor declares a name and version and receives a source id plus source revision.
The idempotency key is SHA-256 of `name + version + source id + source revision`. Outputs use
stable ids recorded in a processing-job record. An existing completed job with that key is a
cache hit. Uncertain mutations are emitted as review items or proposed changes.

Writers create a temporary sibling, flush and sync it, validate it, then atomically rename.
Leases are created with exclusive file creation and include an expiry. A processor verifies
the source revision again before committing derived output.

## Capture/server ownership

The capture app owns original collection, raw OCR preservation, deterministic normalization,
user context, durable local save, and sync queueing. The server owns enhanced OCR,
classification, entity resolution, matching, interactions, inference, review, and derived
indexes. Both can be replaced independently because neither calls the other's internals.
