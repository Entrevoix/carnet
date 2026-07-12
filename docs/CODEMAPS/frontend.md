# Frontend — screens & components
<!-- Generated: 2026-07-12 | Files scanned: ~135 (78 src + tests) | Token estimate: ~760 -->

## Navigation — `apps/mobile/App.tsx` (native-stack)
```
Home → Capture | PhotoCapture | AudioCapture | ShareReceive | RecentDetail
     | TagBrowser | Search | Settings
```
Capture modes route through `CaptureFab` (Idea one-tap; Journal/Contact/Photo/Audio
behind the "more modes" chevron sheet).

## Screens (`apps/mobile/src/screens`) — smoke tests exist for all (headless)
| screen | ln | role |
|---|---|---|
| `HomeScreen` | 445 | recents list + `CaptureFab`; one-shot `VoiceReadinessBanner` |
| `CaptureScreen` | 803 | Idea/Journal/Contact text capture; dictation; Tags+Location; save-first |
| `PhotoCaptureScreen` | 507 | camera → vision enrichment (Photo) |
| `AudioCaptureScreen` | 629 | record → on-device transcribe → journal |
| `RecentDetailScreen` | 1416 | note view + WYSIWYG edit, tags, geo, attachments, Karakeep export |
| `ShareReceiveScreen` | 627 | Android share-sheet intake (image / link) |
| `SearchScreen` | 284 | vault full-text/tag search (B6), stamp-based filters |
| `TagBrowserScreen` | 140 | tags + counts → routes into Search |
| `SettingsScreen` | 794 | OmniRoute URL/key + chat/vision models, Karakeep, voice check, flags |

Business logic lives in extracted `lib/*.ts` modules (ideaSaveFirst, saveFirstOutcome,
captureErrorDecision, attachmentPersistence, promoteIdeaOnDisk, noteReprocess,
wysiwygSave, vaultImageInsert, settingsForm, modelBrowser, shareHelpers…) — screens are
mostly UI. Prefer extending those modules over adding inline screen logic.

## Components (`apps/mobile/src/components`)
`CaptureFab` (mode launcher) · `CaptureModeInput` (per-mode input incl. Contact card-scan
entry) · `CardScannerModal` (expo-camera → `ocrCardViaVision`) · `CaptureViews` ·
`WysiwygEditor` + `MarkdownToolbar` + `bridges/MarkdownBridge` (TenTap WebView) ·
`TagInput` · `LocationChip` · `NoteCard` · `StampChip` · `SyncStatusDot` ·
`PromptOverridesSection`.

## Voice (`apps/mobile/src/voice`)
`VoiceButton` (1541 — tap-to-toggle dictation; failover chain; silence auto-stop after 2
quiet windows; 3-min cap; mic-revoked recovery sheet with App-info deep link via
`requireOptionalNativeModule('ExpoIntentLauncher')`) · `sttErrorPolicy` (277, PURE
decision ladder + tests — the errorHandlingRef latch invariant lives here) ·
`recognizerSelect` · `sttErrorMessage` · `sttOnboarding` · `sttReadiness` ·
`VoiceReadinessBanner` · `VoiceSetupCheck`.

## State & theming
React local state; `lib/settings.ts` (AsyncStorage blob `carnet:settings:v2`; API keys
in SecureStore). Theming via `lib/theme.ts` `useCarnetTheme` tokens — DESIGN.md is the
visual contract (Stamped Paper). Maestro flows in `apps/mobile/.maestro/`.
