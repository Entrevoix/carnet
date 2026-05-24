# Implementation Report: Android app shortcuts

## Summary
Long-pressing the carnet launcher icon now reveals 4 quick-launch shortcuts (Idea / Journal / Photo / Contact) that jump straight into the right capture screen via `carnet://` deep links. Implementation: 1 new Expo config plugin (CommonJS, 132 lines) + JSON entry + a React Navigation `linking` config. No Kotlin, no native module — all 4 planned tasks complete; no deviations.

## Assessment vs Reality

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Small | Small (matched) |
| Confidence | 9/10 | 10/10 — prebuild verification passed first try, all 5 resource files emitted exactly as designed |
| Files Changed | 1 new + 2 modified | 1 new + 2 modified (matched) |
| New tests | 0 (declarative + build-time) | 0 (matched) |
| Test count after | 161/161 (unchanged) | 161/161 (unchanged) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `withAppShortcuts.js` config plugin | ✅ | Two-stage: `withAndroidManifest` injects `<meta-data>`, `withDangerousMod` writes shortcuts.xml + 4 vector drawables. Idempotent on re-prebuild |
| 2 | Wire plugin into app.json | ✅ | Added `"./plugins/withAppShortcuts"` after the existing speech-recognition plugin |
| 3 | React Navigation `linking` config in App.tsx | ✅ | `LinkingOptions<RootStackParamList>` mapping carnet:// paths to stack screens; passed to `<NavigationContainer linking={linking}>` |
| 4 | Validate (typecheck + tests + prebuild check) | ✅ | tsc clean; 161/161 tests pass; clean `expo prebuild` generated all 5 files + the manifest meta-data line |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `tsc --noEmit` clean |
| Unit Tests | ✅ Pass | 161/161; no new tests (declarative config + build-time infra) |
| Prebuild | ✅ Pass | `expo prebuild --platform android` from a clean state emitted: `res/xml/shortcuts.xml` (1961b), 4 × `res/drawable/shortcut_*.xml` (576-628b each), and the `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts"/>` line inside MainActivity |
| Integration | N/A | No integration harness for RN screens or Android launchers |
| Edge Cases | ⏸️ | On-device only (launchers vary by vendor; covered by manual checklist) |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/plugins/withAppShortcuts.js` | CREATED | +132 |
| `apps/mobile/App.tsx` | UPDATED | +24/-1 (LinkingOptions import, linking const, prop on NavigationContainer) |
| `apps/mobile/app.json` | UPDATED | +1 (plugin entry) |

## Deviations from Plan
None. Implementation tracked the plan exactly.

## Issues Encountered

1. **Stale LSP cache flagged PhotoCaptureScreen as missing** — same false alarm seen throughout this session. Authoritative `tsc --noEmit` was clean. No action.
2. **CommonJS conversion hint** — TypeScript's "could be ESM" suggestion on the plugin file. Ignored — Expo config plugins are required to be CommonJS (matches existing `withSpeechRecognitionQueries.js`).

## Tests Written
None. The plugin is build-time infrastructure (validated by prebuild output) and the linking config is a declarative object (testing via mocked React Navigation would be more brittle than it's worth). Coverage:
- Prebuild output verified byte-by-byte (5 files + manifest line)
- Existing 161-test suite still green (no regression)
- Manual on-device validation per the plan's 9-item checklist

## Manual Validation Hand-off

**Native rebuild required** — the AndroidManifest + resource files changed. Use the wrapper from PR #12:

```bash
cd apps/mobile && npm run android
```

(Which runs `bash ./scripts/run-android.sh` → adb reverse → REACT_NATIVE_PACKAGER_HOSTNAME=localhost → `expo run:android`.)

After install:
- [ ] Open Android launcher, long-press the carnet icon → 4 shortcuts appear (Idea / Journal / Photo / Contact, top to bottom)
- [ ] Each shortcut has its indigo Material icon (lightbulb / mic / camera / person)
- [ ] Tap "Idea" → app opens DIRECTLY to the Capture screen with `mode = idea`
- [ ] Tap "Journal" → Capture with `mode = journal` (voice button visible)
- [ ] Tap "Contact" → Capture with `mode = person`
- [ ] Tap "Photo" → PhotoCapture screen
- [ ] Tap launcher icon (no long-press) → Home (unchanged)
- [ ] Regression: Android share intent (image/url/text) still routes to ShareReceive
- [ ] Regression: all capture + save flows complete end-to-end

## Next Steps
- `/code-review` self-review pass
- `/prp-commit` + `/prp-pr` against `main`
- On-device walk after PR lands

## Follow-ups (NOT in this PR)
- **Persistent notification with quick-capture buttons** — bigger PR, needs a Kotlin foreground-service module. Closes the lock-screen-to-capture loop.
- **Home-screen widget** — even bigger PR, AppWidgetProvider + RemoteViews. Best long-term UX, biggest native lift.
- **Dynamic shortcuts** based on usage frequency from `recordCapture()` — one-line tweak once the static set is settled.
- **iOS Home Screen quick actions** — same idea via `UIApplicationShortcutItem`; future PR when iOS lands.
