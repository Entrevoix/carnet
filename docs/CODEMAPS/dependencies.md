# Dependencies & integrations
<!-- Generated: 2026-07-12 | Files scanned: ~135 (78 src + tests) | Token estimate: ~640 -->

## External services
| service | role | code |
|---|---|---|
| OmniRoute (self-hosted LLM gateway) | ALL AI calls: chat + vision enrichment, card OCR (`ocrCardViaVision`) — OpenAI-compatible, always `stream:false` | `lib/omniroute.ts`; URL/models in Settings, key in SecureStore |
| Karakeep (self-hosted) | opt-in per-note export → bookmark + tags + asset attachments (HTTPS REST `/api/v1`) | `lib/karakeep.ts`, `lib/karakeepExport.ts`, `lib/karakeepAssetSync.ts`; URL + key in Settings (key in SecureStore) |
| Syncthing | p2p folder sync (device local folder ↔ workstation vault) | no app code — runs alongside |

## Native / Expo (`apps/mobile`)
- `expo` ~54, `react-native` 0.81 (New Architecture)
- `expo-location` ~19 — device coords → `lib/location.ts`
- audio recording → `AudioCaptureScreen`, `lib/audioDecoder.ts`, `lib/audioTranscribeOnDevice.ts`
- camera + OCR/vision → `PhotoCaptureScreen`, `CardScannerModal` → `ocrCardViaVision()` in `lib/omniroute.ts`
- STT — `expo-speech-recognition` (patched: `patches/expo-speech-recognition+3.1.3.patch`
  fixes a native double-settle crash) → `voice/`; no cloud STT fallback (Whisper removed 5090f33)
- `expo-intent-launcher` ~13 — App-info deep link on the mic-revoked recovery sheet;
  accessed ONLY via `requireOptionalNativeModule` (static import crashes pre-rebuild clients)
- `@10play/tentap-editor` 1.0.1 — WYSIWYG (editor-web bundle + `MarkdownBridge`)
- `@react-native-async-storage/async-storage` — offline queue, settings, tag cache, Karakeep asset record
- `expo-secure-store` — OmniRoute + Karakeep API keys
- `expo-document-picker` / `expo-sharing` — attachments

## Desktop (`apps/desktop`)
Tauri (Rust) + React + `react-router-dom` + `@tauri-apps/api`; consumes `@carnet/shared`.

## Shared
`@carnet/shared` — types + markdown helpers; imported by mobile and desktop.

## CI
`.github/workflows/ci.yml` — jobs: **shared → mobile · desktop · mobile-android (parallel) →
gate** (required check) + advisory **apk** (release-signed artifact, 14-day retention).
`mobile-android` runs Expo prebuild + `gradlew :app:compileDebugKotlin` (catches native/config-
plugin regressions). Shared Android toolchain via `.github/actions/android-toolchain`.
`release.yml` on `v*.*.*` tags builds + verifies + publishes a signed APK. See CLAUDE.md.
