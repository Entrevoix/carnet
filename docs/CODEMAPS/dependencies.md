# Dependencies & integrations
<!-- Generated: 2026-06-11 | Files scanned: ~41 | Token estimate: ~550 -->

## External services
| service | role | code |
|---|---|---|
| OmniRoute / navetted | LLM enrichment (HTTPS) | `lib/omniroute.ts`; token stored by Tauri desktop |
| Syncthing | p2p folder sync (device local folder ↔ workstation vault) | no app code — runs alongside |

## Native / Expo (`apps/mobile`)
- `expo` ~54, `react-native` 0.81 (New Architecture)
- `expo-location` ~19 — device coords → `lib/location.ts`
- audio recording → `AudioCaptureScreen`, `lib/audioDecoder.ts`, `lib/audioTranscribeOnDevice.ts`
- camera + OCR/vision → `PhotoCaptureScreen`, `lib/ocr.ts`, `CardScannerModal`
- `@10play/tentap-editor` 1.0.1 — WYSIWYG (editor-web bundle + `MarkdownBridge`)
- `@react-native-async-storage/async-storage` — offline queue, settings, tag cache
- `expo-document-picker` / `expo-sharing` — attachments

## Desktop (`apps/desktop`)
Tauri (Rust) + React + `react-router-dom` + `@tauri-apps/api`; consumes `@carnet/shared`.

## Shared
`@carnet/shared` — types + markdown helpers; imported by mobile and desktop.

## CI
`.github/workflows/ci.yml` — jobs: **shared · mobile · desktop · gate**.
