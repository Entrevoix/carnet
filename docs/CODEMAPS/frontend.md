# Frontend — screens & components
<!-- Generated: 2026-07-17 | Files scanned: ~152 (87 src + tests) | Token estimate: ~800 -->

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
| `HomeScreen` | ~600 | recents + `CaptureFab`; voice/pending-Karakeep/sync-conflict banners; conflict review dialog; cold-start report |
| `CaptureScreen` | 803 | Idea/Journal/Contact text capture; dictation; Tags+Location; save-first |
| `PhotoCaptureScreen` | 507 | camera → vision enrichment (Photo) |
| `AudioCaptureScreen` | 629 | record → on-device transcribe → journal |
| `RecentDetailScreen` | ~1560 | note view + WYSIWYG edit, tags, geo, attachments, Related card (lib/relatedNotes), Karakeep export (unreachable → pending-sync queue) |
| `ShareReceiveScreen` | 633 | Android share-sheet intake (image / audio / link / any file; reads via content:// grant) |
| `SearchScreen` | 284 | vault full-text/tag search (B6), stamp-based filters |
| `TagBrowserScreen` | 140 | tags + counts → routes into Search |
| `SettingsScreen` | 802 | OmniRoute URL/key + chat/vision models, Karakeep, voice check, flags |

`App.tsx` (295) also mounts the pending-sync drain trigger (cold start + AppState→active,
30s throttle) — see backend.md "Pending-sync queue".

Business logic lives in extracted `lib/*.ts` modules (ideaSaveFirst, saveFirstOutcome,
captureErrorDecision, attachmentPersistence, promoteIdeaOnDisk, noteReprocess,
enhanceProse, wysiwygSave, vaultImageInsert, settingsForm, modelBrowser, shareHelpers…)
— screens are mostly UI. Prefer extending those modules over adding inline screen logic.

`enhanceProse` is the ⋮-sheet "Enhance" action: it splits frontmatter + the `# Title` off
a saved note, sends only the prose to `dispatcher.enhanceProse`, and re-attaches them
around the result (stamping `enhanced:`). It sits beside `noteReprocess` rather than
inside it because that module's flows all require a paired binary on disk; Enhance needs
none, which is why it works on a text-only journal entry. Routing honours
`Settings.enhanceProviderId` — a dedicated, usually stronger provider that takes
precedence over the active one (the inverse of `visionProviderId`'s rung).

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
