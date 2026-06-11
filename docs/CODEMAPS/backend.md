# Device Pipeline & Integrations
<!-- Generated: 2026-06-11 | Files scanned: ~41 | Token estimate: ~700 -->

No HTTP server. The "backend" is the **on-device enrichment + persistence pipeline**.

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

## Persistence — `lib/writer.ts` (1059 ln)
`writeIdea` `writePerson` `writeBinary` `appendJournal` `updateNote` `moveToArchive`
`readNote` `listNoteFiles`; attachments `injectAttachments` `listPairedBinaries`
`resolvePairedUri` `stripPairedBinaryLinks`; `slugify` `personFilename` `mimeFromFilename`.
Frontmatter helpers live in `lib/frontmatter.ts` (byte-exact header preservation).

## Offline queue — `lib/queue.ts` (AsyncStorage, 321 ln)
`enqueue` → `drainQueue` (on reconnect); `getQueueDepth` `getAllQueueRows` `clearFailedRows`.
Both online (`confirmSave`) and offline (`processRow`) paths inject tags + location frontmatter.

## On-device extras
STT `voice/VoiceButton.tsx` + `voice/recognizerSelect.ts`; OCR `lib/ocr.ts`;
on-device transcribe `lib/audioTranscribeOnDevice.ts`; notifications `lib/captureNotification.ts`.

## Desktop — `apps/desktop/src-tauri` (Rust)
`#[tauri::command]` `get_navetted_token` / `set_navetted_token` / `delete_navetted_token`
(LLM-gateway token held in the OS keychain).
