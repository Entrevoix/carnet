# Dependencies & integrations
<!-- Generated: 2026-06-14 | Files scanned: ~53 | Token estimate: ~600 -->

## External services
| service | role | code |
|---|---|---|
| OmniRoute / navetted | LLM enrichment (HTTPS) | `lib/omniroute.ts`; token stored by Tauri desktop |
| Karakeep (self-hosted) | opt-in per-note export → bookmark + tags + asset attachments (HTTPS REST `/api/v1`) | `lib/karakeep.ts`, `lib/karakeepExport.ts`, `lib/karakeepAssetSync.ts`; URL + key in Settings (key in SecureStore) |
| Syncthing | p2p folder sync (device local folder ↔ workstation vault) | no app code — runs alongside |

## Native / Expo (`apps/mobile`)
- `expo` ~54, `react-native` 0.81 (New Architecture)
- `expo-location` ~19 — device coords → `lib/location.ts`
- audio recording → `AudioCaptureScreen`, `lib/audioDecoder.ts`, `lib/audioTranscribeOnDevice.ts`
- camera + OCR/vision → `PhotoCaptureScreen`, `CardScannerModal` → `ocrCardViaVision()` in `lib/omniroute.ts`
- STT — `expo-speech-recognition` (on-device model download for the code-12 dead-end) → `voice/`
- `@10play/tentap-editor` 1.0.1 — WYSIWYG (editor-web bundle + `MarkdownBridge`)
- `@react-native-async-storage/async-storage` — offline queue, settings, tag cache, Karakeep asset record
- `expo-secure-store` — OmniRoute + Karakeep API keys
- `expo-document-picker` / `expo-sharing` — attachments

## Desktop (`apps/desktop`)
Tauri (Rust) + React + `react-router-dom` + `@tauri-apps/api`; consumes `@carnet/shared`.

## Shared
`@carnet/shared` — types + markdown helpers; imported by mobile and desktop.

## CI
`.github/workflows/ci.yml` — jobs: **shared · mobile · desktop · gate** (build:shared, then per-app
`tsc --noEmit`; shared + desktop also run vitest; desktop runs a Vite build smoke). `gate` is the
branch-protection required check.
