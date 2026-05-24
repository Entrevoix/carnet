# Plan: Android app shortcuts for capture modes (slate #2, minimal)

## Summary
Long-press carnet's launcher icon on Android to see 4 quick-launch shortcuts: **Idea**, **Journal**, **Photo**, **Contact**. Each opens the app straight into the right capture screen via a `carnet://...` deep link, skipping the Home screen entirely. Closes the "Obsidian is too slow to capture" gap from the market research using the smallest available native surface — no Kotlin module, no foreground service, no widget plumbing.

## User Story
As a carnet user who just had an idea or wants to log a contact,
I want to long-press the app icon and tap "Idea" or "Contact",
So that I'm typing into the right capture mode in 1 tap instead of 3 (launch app → Home → mode button).

## Problem → Solution
**Current:** Tapping the launcher icon opens carnet's Home screen. Three additional taps (one to pick a capture mode, plus the Capture screen render, plus the keyboard appearing) to start typing.

**Desired:** Long-press the launcher icon → 4 shortcuts appear in the system menu → tap one → app opens directly to that capture mode's screen with the keyboard already up.

## Metadata
- **Complexity:** Small
- **Source PRD:** N/A — slate item #2 from the market-research feature menu
- **PRD Phase:** v0.3
- **Estimated Files:** 1 new (plugin) + 2 modified (app.json, App.tsx)
- **Confidence Score:** 9/10 — Android app shortcuts are well-trodden; the only real unknown is whether the existing `scheme: "carnet"` intent-filter already routes the deep-links cleanly or needs an extra entry

---

## UX Design

### Before
```
launcher icon (long-press)
  ┌─────────────────────────┐
  │ App info                │
  │ Pause app               │   ← system options only
  │ Uninstall               │
  └─────────────────────────┘
```

### After
```
launcher icon (long-press)
  ┌─────────────────────────┐
  │ 💡 Idea                 │   ← carnet://capture/idea
  │ 🎤 Journal              │   ← carnet://capture/journal
  │ 📷 Photo                │   ← carnet://photo
  │ 👤 Contact              │   ← carnet://capture/person
  │ ─────────────────────── │
  │ App info                │
  │ Pause app               │
  │ Uninstall               │
  └─────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Long-press launcher icon | system menu only | + 4 carnet shortcuts above | Android 7.1+ feature, supported on every Pixel and most other launchers |
| Tap "Idea" shortcut | — | App opens directly to `CaptureScreen` with `mode: "idea"` | Skips Home; keyboard auto-focuses |
| Tap "Journal" shortcut | — | `CaptureScreen` with `mode: "journal"` | Same |
| Tap "Contact" shortcut | — | `CaptureScreen` with `mode: "person"` | Same |
| Tap "Photo" shortcut | — | `PhotoCaptureScreen` | Different screen, no `mode` param |
| Tap launcher icon (no long-press) | Home | Home | unchanged |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/plugins/withSpeechRecognitionQueries.js` | 1-28 | Existing config-plugin pattern — CommonJS, uses `@expo/config-plugins`. Mirror the shape. |
| P0 | `apps/mobile/app.json` | plugins array | Where to add the new plugin entry |
| P0 | `apps/mobile/App.tsx` | NavigationContainer, RootStackParamList | Add `linking` config so deep-link URIs route to the right screens |
| P1 | (Android docs) https://developer.android.com/develop/ui/views/launch/shortcuts/creating-shortcuts | — | Static shortcut XML shape, MAX 5 shortcuts ranking by `android:shortcutRank` |
| P1 | (React Navigation) https://reactnavigation.org/docs/configuring-links/ | — | `linking` prop config for deep links into stack navigators |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Custom scheme already declared | `app.json:5` | `"scheme": "carnet"` — Expo's prebuild auto-adds the `<intent-filter>` for `carnet://*` to MainActivity |
| Existing config plugin | `plugins/withSpeechRecognitionQueries.js` | Reference for the new plugin's shape |
| Plugins array | `app.json` `expo.plugins[]` | Add `"./plugins/withAppShortcuts"` |
| Existing screens to route to | `App.tsx` `RootStackParamList` | `Capture: { mode }`, `PhotoCapture: undefined` |
| Existing deep-link consumer | `App.tsx` `ShareIntentRouter` | Uses expo-share-intent; the new linking config doesn't conflict (different URI shape: `carnet://capture/*` vs share-intent's `EXTRA_TEXT` / `EXTRA_STREAM`) |

---

## Patterns to Mirror

### CONFIG_PLUGIN_SHAPE
```js
// SOURCE: apps/mobile/plugins/withSpeechRecognitionQueries.js
const { withAndroidManifest } = require('@expo/config-plugins');
module.exports = function withFoo(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    // ... mutate manifest ...
    return cfg;
  });
};
```
For shortcuts we need TWO mods:
- `withAndroidManifest` — inject `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />` inside the MainActivity application tag
- `withDangerousMod` — write the actual `res/xml/shortcuts.xml` + `res/drawable/shortcut_*.xml` files during prebuild (no built-in modifier for resource files; `withDangerousMod` is the canonical escape hatch)

### REACT_NAVIGATION_LINKING_CONFIG
```ts
// In App.tsx near the NavigationContainer
const linking = {
  prefixes: ['carnet://'],
  config: {
    screens: {
      Home: '',
      Capture: 'capture/:mode',
      PhotoCapture: 'photo',
      Settings: 'settings',
      ShareReceive: 'share-receive',
    },
  },
};
// ...
<NavigationContainer linking={linking} ...>
```
React Navigation parses `carnet://capture/idea` → `Capture` screen with `route.params.mode = "idea"`. No code change in CaptureScreen needed — it already reads `mode` from `route.params`.

### SHORTCUT_XML_TEMPLATE (what the plugin writes)
```xml
<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
    android:shortcutId="idea"
    android:enabled="true"
    android:icon="@drawable/shortcut_idea"
    android:shortcutShortLabel="@string/shortcut_idea_short"
    android:shortcutLongLabel="@string/shortcut_idea_long">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="us.beary.carnet"
      android:targetClass="us.beary.carnet.MainActivity"
      android:data="carnet://capture/idea" />
  </shortcut>
  <!-- repeat for journal, photo, person -->
</shortcuts>
```

### VECTOR_DRAWABLE_TEMPLATE (4× one per mode)
```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#5E63FF"
        android:pathData="<material-icon path-data>" />
</vector>
```
Fill color = the Ink & Mist primary (`#5E63FF`) so shortcuts feel branded. Single-color outlined icons match the Material system style.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/plugins/withAppShortcuts.js` | CREATE | The new config plugin. Single CommonJS file. |
| `apps/mobile/app.json` | UPDATE | Add `"./plugins/withAppShortcuts"` to the plugins array |
| `apps/mobile/App.tsx` | UPDATE | Add `linking` config + pass to `<NavigationContainer linking={linking}>` |

## NOT Building
- **Persistent notification with quick-capture buttons** — separate, larger PR (needs a Kotlin foreground-service native module).
- **Home-screen widget** — separate, even larger PR (needs AppWidgetProvider + RemoteViews).
- **Quick Settings tile** (Android 13+) — niche, defer.
- **Dynamic shortcuts** (changing based on usage) — static shortcuts are enough for v0.3.
- **iOS Home Screen quick actions** — iOS isn't shipping yet; same idea via `UIApplicationShortcutItem` is a future PR when iOS lands.
- **Settings to customize which shortcuts appear** — defer; the 4 capture modes are the canonical set.

---

## Step-by-Step Tasks

### Task 1: Author `withAppShortcuts.js` config plugin
- **ACTION:** Create `apps/mobile/plugins/withAppShortcuts.js`.
- **IMPLEMENT:** Two-stage plugin:
  1. `withAndroidManifest` — find the `<activity android:name=".MainActivity">` entry and inject `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />` inside it (idempotent — don't double-add on re-prebuild).
  2. `withDangerousMod` (Android platform) — write:
     - `android/app/src/main/res/xml/shortcuts.xml` (the 4-shortcut XML)
     - `android/app/src/main/res/drawable/shortcut_idea.xml` (vector drawable)
     - `android/app/src/main/res/drawable/shortcut_journal.xml`
     - `android/app/src/main/res/drawable/shortcut_photo.xml`
     - `android/app/src/main/res/drawable/shortcut_person.xml`
     - Inline the labels into the shortcut XML rather than a separate strings file — saves one file, no localization story today
  3. The plugin function should be exported via `module.exports = function withAppShortcuts(config) { ... }` — match `withSpeechRecognitionQueries` style.
- **MIRROR:** `CONFIG_PLUGIN_SHAPE` for the AndroidManifest mod. Use Material Icons SVG path data for the 4 drawables (lightbulb-outline, mic-outline, camera-outline, person-outline). Fill color `#5E63FF` to match the design system.
- **IMPORTS:** `@expo/config-plugins` (already available).
- **GOTCHA:**
  - `android:data="carnet://capture/idea"` in the shortcut intent — the URI must EXACTLY match what React Navigation's `linking` config expects. Trailing slashes, paths, query params all matter.
  - The intent needs `android:action="android.intent.action.VIEW"` AND the `android:targetPackage` + `android:targetClass` BOTH set, OR the launcher silently drops the shortcut.
  - `android:targetClass="us.beary.carnet.MainActivity"` — must match the actual MainActivity FQN. Expo SDK 54 default is the namespace + `.MainActivity`.
  - `withDangerousMod` runs after autolinking — file writes are safe at that point. `fs.mkdirSync` with `{ recursive: true }` to handle a missing `res/xml/` or `res/drawable/` dir on first prebuild.
  - Use `android:shortcutRank` to order shortcuts top→bottom (rank 0 = top). Idea = 0, Journal = 1, Photo = 2, Person = 3.
- **VALIDATE:** After Task 4, run `npx expo prebuild --platform android --clean` and inspect `android/app/src/main/res/xml/shortcuts.xml` exists with the right content; same for drawables; AndroidManifest.xml has the meta-data inside the MainActivity entry.

### Task 2: Wire plugin into app.json
- **ACTION:** Edit `apps/mobile/app.json` plugins array.
- **IMPLEMENT:** Add `"./plugins/withAppShortcuts"` after the existing `"./plugins/withSpeechRecognitionQueries"` entry.
- **MIRROR:** the existing string-form plugin entries.
- **GOTCHA:** None — JSON edit only.
- **VALIDATE:** prebuild runs without errors.

### Task 3: Add React Navigation linking config
- **ACTION:** Edit `apps/mobile/App.tsx`.
- **IMPLEMENT:**
  ```ts
  import type { LinkingOptions } from '@react-navigation/native';

  const linking: LinkingOptions<RootStackParamList> = {
    prefixes: ['carnet://'],
    config: {
      screens: {
        Home: '',
        Capture: 'capture/:mode',
        PhotoCapture: 'photo',
        Settings: 'settings',
        ShareReceive: 'share-receive',
        // RecentDetail intentionally omitted — its param is an object,
        // not URL-encodable. Deep-linking into a specific recent isn't
        // a use case here.
      },
    },
  };

  // and pass it:
  <NavigationContainer ref={navRef} theme={navTheme} linking={linking}>
  ```
- **MIRROR:** `REACT_NAVIGATION_LINKING_CONFIG`.
- **IMPORTS:** `LinkingOptions` type from `@react-navigation/native`.
- **GOTCHA:**
  - The `Capture: 'capture/:mode'` route requires the path param to be a string. `mode` is typed as `"idea" | "journal" | "person" | "photo"` in `RootStackParamList`; React Navigation accepts any string at the linking layer — invalid values would route to CaptureScreen with a bad `mode` prop, which would render the screen but the existing CaptureScreen logic falls through to a default. Acceptable degradation.
  - The deep-link router and `ShareIntentRouter` coexist — different URI shapes (`carnet://capture/*` vs share intent's `EXTRA_TEXT/STREAM`). The expo-share-intent provider runs first; if there's no share intent the linking config takes over.
  - URI parsing: `carnet://capture/photo` would route to `Capture` with `mode: "photo"` — but we want `PhotoCapture`. Solved by registering `PhotoCapture: 'photo'` (no `capture/` prefix) — the routes are distinct paths.
- **VALIDATE:** Manual on-device after Task 4.

### Task 4: Validation (typecheck + tests)
- **ACTION:** `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`.
- **VALIDATE:** 0 type errors; existing 161 tests still pass (no new tests since the plugin is pre-build infrastructure and the linking config is declarative).

### Task 5: On-device validation
- **ACTION:** `cd apps/mobile && npm run android` (the wrapper from PR #12 handles adb reverse + localhost). This triggers a prebuild AND a native rebuild — required because we're modifying the AndroidManifest + adding XML resources.
- **VALIDATE:** see Manual Validation checklist.

---

## Testing Strategy

### Unit Tests
**No new unit tests.** The plugin is build-time infrastructure (validated by running prebuild + inspecting the output), and the linking config is a declarative object (testing it via a mock React Navigation would be more brittle than it's worth). Coverage relies on:
- Existing 161-test suite (no regression)
- Manual on-device validation per the checklist below

### Edge Cases Checklist
- [ ] Long-press launcher on Android 7 (API 25) — minimum version for static shortcuts; carnet's `minSdk` is 24, so a single API-25 check would be needed if we want a graceful no-shortcuts fallback on API 24. Acceptable to ship without — API 24 devices just don't see the shortcuts.
- [ ] Long-press with another launcher (Nova, Microsoft Launcher) — most respect the manifest shortcuts; some don't. Document as a launcher-specific quirk if observed.
- [ ] Tap a shortcut while the app is already running — Android's flag handling should bring the existing instance to front + route. If a fresh launch creates a new MainActivity instance, the deep-link still fires via `onCreate`.
- [ ] Tap a shortcut → grant mic permission for the first time (Journal) — permission prompt should fire as normal from `CaptureScreen`'s existing flow.
- [ ] Photo shortcut → CameraScreen — the in-app camera needs the runtime CAMERA permission, already handled.

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 161/161 pass (unchanged).

### Prebuild check (inspect generated files)
```bash
cd apps/mobile
rm -rf android && npx expo prebuild --platform android
test -f android/app/src/main/res/xml/shortcuts.xml && echo "shortcuts.xml: OK"
test -f android/app/src/main/res/drawable/shortcut_idea.xml && echo "drawable: OK"
grep "android.app.shortcuts" android/app/src/main/AndroidManifest.xml && echo "manifest: OK"
```
EXPECT: all three files present + manifest contains the meta-data line.

### On-device
```bash
cd apps/mobile && npm run android
# (uses the PR #12 wrapper, no red screen)
```
EXPECT: app installs, opens, no regression.

### Manual Validation
- [ ] Open the launcher, long-press the carnet icon → 4 shortcuts appear above the system menu (Idea, Journal, Photo, Contact, in that order)
- [ ] Each shortcut has the expected icon (indigo lightbulb / mic / camera / person)
- [ ] Tap "Idea" → app opens DIRECTLY to the Capture screen with mode = idea (text input focused, keyboard up if your soft-keyboard auto-shows)
- [ ] Tap "Journal" → Capture screen with mode = journal (voice button visible)
- [ ] Tap "Contact" → Capture screen with mode = person (camera scan UI)
- [ ] Tap "Photo" → PhotoCapture screen (in-app camera)
- [ ] Tap each shortcut while the app is already in the foreground → it routes to the right screen (existing instance reused)
- [ ] Tap the launcher icon (no long-press) → opens Home (unchanged)
- [ ] Regression: Android share intent (image / URL / text) still routes to ShareReceive
- [ ] Regression: capture + save flow works end-to-end from each shortcut

---

## Acceptance Criteria
- [ ] Long-pressing the carnet launcher icon shows 4 shortcuts (Idea, Journal, Photo, Contact)
- [ ] Each shortcut opens the right capture screen via `carnet://...` deep-link
- [ ] Shortcuts have branded vector-drawable icons (Ink & Mist indigo)
- [ ] The plugin survives `expo prebuild --clean` (regenerable, not a one-shot hand-edit)
- [ ] No type errors; 161 tests pass
- [ ] No regression in share-intent or any capture flow

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Some launchers ignore static shortcuts | Medium | Some users don't see them | Acceptable degradation; stock Pixel / Samsung One UI / most popular launchers respect the manifest |
| `withDangerousMod` runs at the wrong stage and the XML files get clobbered | Low | Shortcuts silently disappear | Verify in the prebuild-check command before any merge |
| Vector drawable path data has a typo and renders blank | Low | Shortcut shows with no icon (just label) | Test manually on device + cross-check against Material Icons reference |
| Deep-link URI conflicts with the existing share-intent handling | Low | Share-receive flow breaks | The two handlers consume different URI shapes (`carnet://capture/*` vs share intent); coexistence is the React Navigation default |
| Capture screen receives an unknown `mode` from a malformed URI | Low | Bad mode rendered | CaptureScreen already handles the four valid modes; an unknown string would render a degraded UI (no crash) |
| Photo capture shortcut on a device without a camera | Very low | Black screen | CameraScreen already handles permission denial; non-existent camera is an extreme edge case |

## Notes
- This is the lightest of the 3 "slate #2" surfaces (shortcuts → notification → widget). The next step up — persistent notification — is its own PR with a real Kotlin module if/when we want to invest.
- The plugin makes the shortcuts *regenerable* — every `expo prebuild --clean` recreates them. No manual `android/` edits, no drift.
- After this lands, the natural follow-up is a one-line tweak to add `android:shortcutRank` based on usage frequency from `getRecentCaptures()` data (e.g. promote the most-used capture mode to rank 0). That's a "dynamic shortcuts" feature documented as NOT Building above.
