# mdcrm

Local-first Markdown contact/event processing for Carnet. This is not a sales CRM and has
no mandatory server, cloud, OCR, or LLM dependency. Markdown files and attachments are the
source of truth; the JSON full-text index is disposable.

## Install and build

From the repository root:

```bash
npm install
npm -w @carnet/mdcrm run build
node apps/mdcrm/dist/src/cli/index.js help
```

Node 20+ is required. Copy `mdcrm.example.yaml` and set `knowledge_base_path`, or pass
`--root /path/to/knowledge-base`. Environment overrides include
`MDCRM_KNOWLEDGE_BASE_PATH`, `MDCRM_LLM_ENABLED`, and `MDCRM_ALLOW_EXTERNAL_API`.

## First run

```bash
mdcrm init --root ./knowledge-base
cp fixtures/capture-business-card.md ./knowledge-base/captures/
mdcrm validate ./knowledge-base/captures/capture-business-card.md --root ./knowledge-base
mdcrm process-capture cap_01K1V8FQ73P2N6TQ84D7KZ19BC --root ./knowledge-base
mdcrm process-inbox --root ./knowledge-base
mdcrm rebuild-index --root ./knowledge-base
mdcrm search "Jane partnerships" --root ./knowledge-base
mdcrm doctor --root ./knowledge-base
```

Append `--json` to any command for machine-readable output. Exit codes: `0` success, `1`
runtime failure, `2` usage error, `3` validation/doctor failure, `4` revision conflict.

## Commands

- `init`
- `validate FILE`
- `scan-inbox`
- `process-inbox`
- `process-capture CAPTURE_ID`
- `classify CAPTURE_ID`
- `extract CAPTURE_ID`
- `normalize email|phone|name|company|url|date VALUE`
- `match-contact CAPTURE_ID`
- `match-company CAPTURE_ID`
- `link-event CAPTURE_ID`
- `rebuild-index`
- `search QUERY`
- `review list|approve|reject [REVIEW_ID]`
- `doctor`

The capture pipeline is deterministic and LLM-free. It validates schemas and attachment
hashes, acquires a lease, computes an idempotency key, ranks exact/deterministic contact
matches, creates derived records or a review item, and records a processing job. It never
automatically merges contacts.

Phase 1 tests cover parsing/writing, schemas and golden fixtures, ids, normalization,
matching, state transitions, attachment failure, optimistic conflicts, repeat processing,
and restart recovery. LLM timeout/invalid-output tests, synchronization retry, and merge
rollback are deferred with the corresponding Phase 2/3 features; Phase 1 performs no LLM
call, remote synchronization, or destructive merge.

## Development

```bash
npm -w @carnet/mdcrm run typecheck
npm -w @carnet/mdcrm test
npm -w @carnet/mdcrm run build
```

See [architecture](../../docs/mdcrm/architecture.md),
[mobile migration](../../docs/mdcrm/mobile-migration.md), and the repository-level threat
model and schema-migration documents under `docs/mdcrm/`.
