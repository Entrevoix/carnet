# Threat Model

## Protected assets

Original images, OCR text, contact coordinates, meeting notes, inferred relationships, API
credentials, processing history, and the integrity/availability of canonical Markdown.

## Likely threats and controls

- **Lost or rooted device / stolen server disk:** Markdown and attachments contain PII.
  Use encrypted device/server filesystems and restrictive permissions. mdcrm creates temp
  files mode `0600`; encryption at rest remains a deployment responsibility.
- **Untrusted capture or YAML:** parser rejects malformed mappings, duplicate YAML keys,
  aliases during object conversion, unknown record types, and schema violations. Paths are
  resolved inside the knowledge-base root.
- **Malicious attachment paths:** resolved paths must remain inside the root; hashes are
  checked before processing. Attachments are not executed.
- **Concurrent processors:** exclusive leases, expiring tokens, idempotency keys, atomic
  writes, and content-hash compare-and-swap limit duplicates and lost updates.
- **LLM prompt/data exfiltration:** Phase 1 has no LLM. External providers are disabled by
  default; future adapters must require `allow_external_api`, default image inclusion off,
  redact configured fields, validate structured output, and emit proposed changes only.
- **Credential exposure:** no API key belongs in Markdown, logs, or export files. Runtime
  secrets must come from a platform secret manager/environment injection.
- **Log leakage:** structured logs contain ids and stage metadata, not full OCR/contact data.
  Debug logging must remain explicit.
- **Sync conflict or rollback attack:** attachment/content hashes and revisions detect
  changes. The server does not silently overwrite a changed source. Version control or
  snapshot backups are recommended for canonical records.
- **Denial of service:** deployment should cap file and attachment sizes, lease duration,
  processor timeouts, and retry counts. Phase 1 verifies hashes but does not yet impose a
  global size quota; this is unresolved before exposing an upload API.

## Trust boundaries

Capture devices, sync transport, server filesystem, optional model process, and human review
UI are separate principals. Filesystem permissions should grant processors only the folders
they need. Indexes are derived and may be deleted without losing canonical data.
