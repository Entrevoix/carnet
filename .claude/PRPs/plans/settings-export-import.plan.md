# PR plan: Settings export and import

Status: in-progress

## Goal

Let a Carnet user move their non-secret settings to another installation (notably after an
Android application-id change) through a versioned JSON file.

## User story

As a Carnet user, I can export my settings from the old app and import them into the new
app, avoiding reconfiguration of providers, prompts, and capture behavior.

## Scope and security decisions

- Export all persisted settings, the appearance preference, and LLM provider definitions.
- **Never export API keys.** OmniRoute, local-LLM, Karakeep, and per-provider keys remain
  in SecureStore and must be re-entered on the destination device. The transfer file is
  ordinary shareable JSON, not an encrypted credential backup.
- On import, clear `content://` capture-folder URIs because Android SAF grants are scoped
  to the source app package; retain ordinary paths. Reset the persistent-notification hint
  to `false`, because the native service does not transfer with settings.
- Parse and validate the entire file before any write. Import replaces the non-secret
  settings blob and clears destination credentials before imported endpoints can be saved.
- Require an explicit confirmation before replacing the target settings.

## Implementation

1. Add `lib/settingsTransfer.ts`, a pure versioned schema/normalization layer with export
   and parse functions.
2. Add unit coverage for round trips, malformed/unsupported files, provider/reference
   validation, secret omission, SAF stripping, and notification reset.
3. Add a Settings screen section using the system share sheet for export and the document
   picker for import. Surface errors in the existing Settings snackbar and confirm before
   replacing settings.
4. Add the required Expo filesystem/document-picker/sharing test stubs and screen wiring
   coverage.
5. Run mobile typecheck, tests, lint, and diff validation.

## Acceptance criteria

- Exported JSON contains a format/version marker and no API-key fields or values.
- Valid import preserves supported non-secret configuration while clearing target API keys:
  retaining a key while importing an endpoint could redirect that credential to an untrusted
  server. Imported custom provider ids are reissued from the target counter for the same reason.
- Invalid, future-version, or malformed files leave settings untouched and explain failure.
- SAF paths and stale native notification state do not transfer.
- The Settings UI makes the credential limitation and replace behavior clear.

## Not building

- Encrypted credential backups or password recovery.
- Queue, drafts, capture history, vault files, or crash logs.
- Automatic migration between app identifiers; users choose the file explicitly.
