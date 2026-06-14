# Frontend — screens & components
<!-- Generated: 2026-06-14 | Files scanned: ~53 | Token estimate: ~680 -->

## Navigation — `apps/mobile/App.tsx` (native-stack)
```
Home → Capture | PhotoCapture | AudioCapture | ShareReceive | RecentDetail | TagBrowser | Settings
```

## Screens (`apps/mobile/src/screens`)
| screen | ln | role |
|---|---|---|
| `HomeScreen` | 349 | capture-mode launcher + recents list; one-shot `VoiceReadinessBanner` |
| `CaptureScreen` | 830 | Idea/Journal text capture; Tags + Location metadata; Send |
| `PhotoCaptureScreen` | 506 | camera → OCR / vision (Person, Photo) |
| `AudioCaptureScreen` | 549 | record → transcribe → journal |
| `RecentDetailScreen` | 1406 | note view + WYSIWYG edit, tags, geo chip, attachments, **Send to Karakeep** |
| `ShareReceiveScreen` | 628 | Android share-sheet intake (image / link) |
| `TagBrowserScreen` | 135 | vault tags + counts → notes → detail |
| `SettingsScreen` | 882 | OmniRoute creds + model, **Karakeep URL+key**, **Voice input** check, feature flags |

## Components (`apps/mobile/src/components`)
`VoiceButton` (1520, STT) · `WysiwygEditor` (286) + `MarkdownToolbar` (70) + `bridges/MarkdownBridge`
(TenTap WebView) · `TagInput` (95, chips + autocomplete) · `LocationChip` (127) ·
`CardScannerModal` (144, OCR).
Voice onboarding (`apps/mobile/src/voice`): `VoiceReadinessBanner` (126, Home one-shot prompt) +
`VoiceSetupCheck` (183, Settings "Check voice setup").

## State & theming
React local/component state; `lib/settings.ts` (AsyncStorage; API keys in SecureStore) for prefs +
flags + OmniRoute/Karakeep creds; `lib/theme.ts`.
The rich editor is a Vite-bundled **TenTap (tiptap) WebView** under `apps/mobile/editor-web/`,
communicating with RN through `bridges/MarkdownBridge.ts` (markdown round-trip).
