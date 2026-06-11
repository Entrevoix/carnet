# Frontend — screens & components
<!-- Generated: 2026-06-11 | Files scanned: ~41 | Token estimate: ~650 -->

## Navigation — `apps/mobile/App.tsx` (native-stack)
```
Home → Capture | PhotoCapture | AudioCapture | ShareReceive | RecentDetail | TagBrowser | Settings
```

## Screens (`apps/mobile/src/screens`)
| screen | ln | role |
|---|---|---|
| `HomeScreen` | 347 | capture-mode launcher + recents list |
| `CaptureScreen` | 830 | Idea/Journal text capture; Tags + Location metadata; Send |
| `PhotoCaptureScreen` | 506 | camera → OCR / vision (Person, Photo) |
| `AudioCaptureScreen` | 549 | record → transcribe → journal |
| `RecentDetailScreen` | 1170 | note view + rich (WYSIWYG) edit, tags, geo chip, attachments |
| `ShareReceiveScreen` | 628 | Android share-sheet intake (image / link) |
| `TagBrowserScreen` | 135 | vault tags + counts → notes → detail |
| `SettingsScreen` | 781 | OmniRoute creds, model pick, feature flags |

## Components (`apps/mobile/src/components`)
`VoiceButton` (1487, STT) · `WysiwygEditor` (119) + `MarkdownToolbar` (70) + `bridges/MarkdownBridge`
(TenTap WebView) · `TagInput` (95, chips + autocomplete) · `LocationChip` (127) ·
`CardScannerModal` (144, OCR).

## State & theming
React local/component state; `lib/settings.ts` (AsyncStorage) for prefs + flags; `lib/theme.ts`.
The rich editor is a Vite-bundled **TenTap (tiptap) WebView** under `apps/mobile/editor-web/`,
communicating with RN through `bridges/MarkdownBridge.ts` (markdown round-trip).
