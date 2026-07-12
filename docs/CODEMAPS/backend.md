# Device Pipeline & Integrations
<!-- Generated: 2026-07-12 | Files scanned: ~135 (78 src + tests) | Token estimate: ~800 -->

No HTTP server. The "backend" is the **on-device enrichment + persistence pipeline**,
plus an opt-in **Karakeep export** REST client.

## Capture → vault  (mode → enrich → write)
```
Idea     CaptureScreen   → omniroute.enrichIdea     → writer.writeIdea      → Ideas/{slug}.md
Journal  CaptureScreen   → omniroute.enrichJournal  → writer.appendJournal  → Journal/YYYY-MM-DD.md
Person   PhotoCapture    → ocr → enrichPerson        → writer.writePerson    → People/F-L.md
Photo    PhotoCapture    → enrich (vision)           → writer.writeBinary    → Photos/{slug}.jpg
Audio    AudioCapture    → transcribe → enrichJournal → appendJournal
Share    ShareReceive    → enrichSharedImage / Link   → writeIdea / writeBinary
```

## LLM client — `lib/omniroute.ts` (HTTPS, 674 ln)
`enrichIdea` `enrichJournal` `enrichPerson` `enrichSharedImage` `enrichSharedLink`
`transcribeAudio` `autoTranscribeIfEnabled` `promoteIdea` `listModels`
errors: `isNotConfiguredError` `isPermanentError`; `withSystemOverride` `assertBase`.

## Persistence — `lib/writer.ts` (1074 ln)
`writeIdea` `writePerson` `writeBinary` `appendJournal` `updateNote` `moveToArchive`
`readNote` `listNoteFiles`; attachments `injectAttachments` `listPairedBinaries`
`resolvePairedUri` (read-only `findSubdir` — never creates dirs) `stripPairedBinaryLinks`;
`slugify` `personFilename` `mimeFromFilename`.
Frontmatter helpers live in `lib/frontmatter.ts` (byte-exact header preservation).

## Offline queue — `lib/queue.ts` (AsyncStorage, 321 ln)
`enqueue` → `drainQueue` (on reconnect); `getQueueDepth` `getAllQueueRows` `clearFailedRows`.
Both online (`confirmSave`) and offline (`processRow`) paths inject tags + location frontmatter.

## Karakeep export — `lib/karakeep.ts` (390) · `lib/karakeepExport.ts` (75) · `lib/karakeepAssetSync.ts` (76)
Opt-in REST client to a self-hosted Karakeep (`{url}/api/v1`, Bearer key, HTTPS-or-LAN).
`createTextBookmark` · `updateTextBookmark` (PATCH — re-export in place, 404→create) · `attachTags` ·
`uploadAsset` (multipart) · `attachAssetToBookmark`. Shared `karakeepFetch` core (hard timeout,
HTTPS enforce, Bearer redaction — mirrors omniroute hardening).
`karakeepExport.pushNoteAttachments` = incremental asset sync; `karakeepAssetSync.ts` keeps a
per-bookmark pushed-key record in AsyncStorage (skip already-synced, retry failed, no dups).
Driven from RecentDetailScreen "Send to Karakeep"; `karakeepId` frontmatter gives idempotency.

## On-device extras
STT `voice/VoiceButton.tsx` + `voice/recognizerSelect.ts`; STT onboarding `voice/sttReadiness.ts`
(en-model probe, code-12 dead-end) + `voice/sttOnboarding.ts` (proactive prompt logic);
card OCR `ocrCardViaVision()` in `lib/omniroute.ts` (chat-vision call; the standalone `/ocr`
client was retired in Stage 2 B2); on-device transcribe `lib/audioTranscribeOnDevice.ts`;
notifications `lib/captureNotification.ts`.

## Desktop — `apps/desktop/src-tauri` (Rust)
`#[tauri::command]` `get_navetted_token` / `set_navetted_token` / `delete_navetted_token`
(LLM-gateway token held in the OS keychain).
