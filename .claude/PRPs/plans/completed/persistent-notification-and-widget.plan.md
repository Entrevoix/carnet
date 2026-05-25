# Plan: Persistent notification + home-screen widget (slate #2 continued)

## Summary
Two new always-on capture surfaces. (1) A persistent foreground-service-backed notification with 4 action buttons (Idea / Journal / Photo / Audio) that survives reboots. (2) A 4x1 home-screen widget with the same 4 buttons. Both fire carnet's existing `carnet://` deep links. Both ship behind their own Expo config plugins so `expo prebuild --clean` regenerates the native layer reproducibly.

## User Story
As a carnet user who wants frictionless capture,
I want quick-capture buttons always accessible from the notification shade and home screen,
So that I never have to find the carnet app icon when an idea hits — one tap and I'm at the right capture screen.

## Problem → Solution
**Current:** Capture is reachable via launcher icon, long-press app shortcuts (PR #15), and share intent. All require N+1 taps depending on where the user is. Lock-screen / notification-shade access requires unlocking + opening + tapping. Friction kills capture rate; this is the central thesis of carnet.

**Desired:** Pull down notification shade → 4 capture buttons. Or long-press home → drop a widget anywhere → 4 capture buttons. Each tap deep-links straight to the right capture screen, no Home detour.

## Metadata
- **Complexity:** Large
- **Source PRD:** N/A — slate #2 from the v0.3 feature menu (continued from PR #15's app shortcuts)
- **PRD Phase:** v0.3
- **Estimated Files:** ~12 new + 2 modified
- **Confidence Score:** 6/10 — Kotlin/Expo native ground is less battle-tested in this codebase than RN. The two highest-risk unknowns are (a) Android 14+ `foregroundServiceType` declaration and (b) RN bridge module registration via Expo config plugin's `withMainApplication`. Both are documented Android APIs but easy to get wrong; on-device verification is mandatory.

---

## UX Design

### Persistent notification (notification shade)
```
┌──────────────────────────────────────────┐
│  CARNET                                  │
│  Quick capture                           │
│                                          │
│  [💡 Idea] [🎤 Journal] [📷 Photo] [🎙 Audio] │
└──────────────────────────────────────────┘
```
- Lives in the "Capture" notification channel (low importance — no sound, no vibration, lock-screen visible)
- `setOngoing(true)` — can't be swiped away
- Tapping the notification body opens Home; tapping an action fires the deep link directly
- Toggle on/off from Settings → "Persistent capture notification"
- Auto-restores on device reboot if the user had it enabled

### Home-screen widget
```
┌─────────────────────────────────────┐
│  [💡] [🎤] [📷] [🎙]                  │
│  Idea  Journ Photo Audio             │
└─────────────────────────────────────┘
```
- 4x1 cell footprint (minWidth ~250dp, minHeight ~40dp — uses Android's resize-friendly defaults)
- 4 ImageButtons in a horizontal LinearLayout, each with its label below
- Pure RemoteViews — no JS runs when the user taps, the PendingIntent deep-links directly into the app
- Added via standard Android home-screen long-press → Widgets picker → carnet

### Interaction changes
| Touchpoint | Before | After |
|---|---|---|
| Notification shade | empty (no carnet) | persistent 4-button row if enabled |
| Home screen | launcher icon + long-press shortcuts (PR #15) | + optional widget anywhere |
| Settings | URL, key, model, transcription, folder, prompt overrides | + "Persistent capture notification" toggle |
| First-run | no extra perms | POST_NOTIFICATIONS runtime perm prompt when user flips the toggle on (Android 13+) |
| Reboot | shortcuts persist (manifest), notification disappears | notification re-posts automatically via BootReceiver |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/plugins/withAppShortcuts.js` | all | Reference for the Expo config plugin shape — withAndroidManifest + withDangerousMod. Same pattern, more files emitted. |
| P0 | `apps/mobile/app.json` | 22-59 | Plugins array — register the two new plugins; android.permissions — add FOREGROUND_SERVICE, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED |
| P0 | `apps/mobile/scripts/verify-shortcuts-prebuild.sh` | all | Pattern for verifying a config plugin emits the right artifacts. Mirror as `verify-notification-and-widget-prebuild.sh`. |
| P0 | `apps/mobile/App.tsx` | 54-65 | Linking config — confirm the deep-link routes the notification + widget will fire (already exist: `carnet://capture/:mode`, `carnet://photo`, `carnet://audio`) |
| P1 | `apps/mobile/src/screens/SettingsScreen.tsx` | 86-141 | Form state shape — add the new toggle. |
| P1 | `apps/mobile/src/lib/settings.ts` | 32-49 | Settings interface — add `persistentNotificationEnabled: boolean` |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Expo config plugin | `plugins/withAppShortcuts.js` | `withAndroidManifest` for manifest mods + `withDangerousMod` for resource file writes |
| Vector drawable icons | `withAppShortcuts.js:28-41` | Existing `shortcut_idea/journal/photo/person.xml` — reuse for both surfaces; add a new `shortcut_audio.xml` (mic icon, indigo) |
| Deep-link mapping | `App.tsx:54-65` | `carnet://capture/idea`, `carnet://capture/journal`, `carnet://photo`, `carnet://audio` |
| Native module registration | none yet | This PR establishes the first one. Pattern: `CaptureNotificationPackage` implementing `ReactPackage`, registered via `withMainApplication` plugin |
| Verification script | `scripts/verify-shortcuts-prebuild.sh` | Mirror it: clean prebuild → grep for emitted files + manifest line → exit 1 on miss |

---

## Patterns to Mirror

### EXPO_PLUGIN_SHAPE (from withAppShortcuts.js)
```js
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

module.exports = function withSomething(config) {
  const packageName = config.android?.package;

  // Stage 1 — manifest mutation (idempotent — don't double-add)
  config = withAndroidManifest(config, (cfg) => {
    // ... mutate cfg.modResults.manifest in place
    return cfg;
  });

  // Stage 2 — write resource / source files
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      // ... fs.writeFileSync(...) for each file
      return cfg;
    },
  ]);

  return config;
};
```

### KOTLIN_PACKAGE_PATH
```
android/app/src/main/java/us/beary/carnet/notification/
  CaptureForegroundService.kt
  CaptureNotificationModule.kt
  CaptureNotificationPackage.kt
  BootReceiver.kt
android/app/src/main/java/us/beary/carnet/widget/
  CaptureWidgetProvider.kt
android/app/src/main/res/layout/
  widget_capture.xml
android/app/src/main/res/xml/
  widget_capture_info.xml
android/app/src/main/res/drawable/
  (reuse shortcut_idea/journal/photo from PR #15 + new shortcut_audio)
```

### FOREGROUND_SERVICE_TYPE (Android 14+ requirement)
```xml
<!-- In AndroidManifest.xml -->
<service
  android:name="us.beary.carnet.notification.CaptureForegroundService"
  android:exported="false"
  android:foregroundServiceType="specialUse">
  <property
    android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
    android:value="capture_shortcut_notification" />
</service>
```
`specialUse` is the right pick for "ongoing notification with UI shortcuts" — it doesn't fit any of the standard types (dataSync, mediaPlayback, etc.). The `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` value is opaque to Android — it's a marker for Play Store reviewers. For sideloaded distribution (carnet's model per PR #13's release script), this works without further declarations.

### PENDING_INTENT_FLAGS
```kotlin
// FLAG_IMMUTABLE is required on Android 12+ (API 31+) for PendingIntents that
// don't need to be mutated by their target. UPDATE_CURRENT lets us re-issue
// the same intent without leaking earlier copies.
val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
val intent = Intent(Intent.ACTION_VIEW, Uri.parse("carnet://capture/idea")).apply {
  setPackage(context.packageName)
}
val pi = PendingIntent.getActivity(context, requestCode, intent, flags)
```

### NOTIFICATION_CHANNEL (Android 8+)
```kotlin
val channel = NotificationChannel(
  "carnet_capture",
  "Capture",
  NotificationManager.IMPORTANCE_LOW,  // no sound, no vibration
).apply {
  description = "Persistent quick-capture shortcuts"
  setShowBadge(false)
}
notifManager.createNotificationChannel(channel)
```

### REMOTE_VIEWS_4_BUTTON_LAYOUT
```xml
<!-- res/layout/widget_capture.xml -->
<LinearLayout
  android:orientation="horizontal"
  android:layout_width="match_parent"
  android:layout_height="wrap_content"
  android:padding="8dp"
  android:background="@android:color/transparent">

  <LinearLayout
    android:id="@+id/btn_idea"
    android:orientation="vertical"
    android:layout_width="0dp"
    android:layout_height="wrap_content"
    android:layout_weight="1"
    android:gravity="center"
    android:padding="8dp"
    android:background="?android:attr/selectableItemBackground">
    <ImageView
      android:layout_width="32dp"
      android:layout_height="32dp"
      android:src="@drawable/shortcut_idea"/>
    <TextView
      android:layout_width="wrap_content"
      android:layout_height="wrap_content"
      android:text="Idea"
      android:textSize="11sp"/>
  </LinearLayout>

  <!-- ... three more cells, identical structure ... -->

</LinearLayout>
```

### WIDGET_INFO_XML
```xml
<!-- res/xml/widget_capture_info.xml -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="250dp"
  android:minHeight="40dp"
  android:targetCellWidth="4"
  android:targetCellHeight="1"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/widget_capture"
  android:resizeMode="horizontal"
  android:widgetCategory="home_screen"
  android:previewLayout="@layout/widget_capture"/>
```
- `updatePeriodMillis="0"` because the widget content never changes (static buttons). Android wakes the widget for updates otherwise, costing battery.
- `targetCellWidth/Height` are Android 12+ hints; older versions fall back to minWidth/minHeight.

---

## Files to Change

### New files
| File | Lines | Purpose |
|---|---|---|
| `apps/mobile/plugins/withCaptureNotification.js` | ~200 | Emits Kotlin service + module + package + boot receiver. Mutates manifest. Adds POST_NOTIFICATIONS / FOREGROUND_SERVICE / RECEIVE_BOOT_COMPLETED perms. Registers package in MainApplication. |
| `apps/mobile/plugins/withCaptureWidget.js` | ~150 | Emits Kotlin AppWidgetProvider + layout XML + info XML. Mutates manifest with widget receiver. Adds `shortcut_audio.xml` drawable (the new icon — PR #15 didn't have one). |
| `apps/mobile/scripts/verify-notification-and-widget-prebuild.sh` | ~80 | Clean prebuild + assert all 10 emitted files present + 3 manifest lines present. Mirrors `verify-shortcuts-prebuild.sh`. |
| `apps/mobile/src/lib/captureNotification.ts` | ~70 | JS facade for the native module. `start()` / `stop()` / `isRunning()`. Handles POST_NOTIFICATIONS perm via expo-notifications. |

### Modified files
| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/settings.ts` | UPDATE | Add `persistentNotificationEnabled: boolean` to Settings + PersistedSettings + DEFAULT_PERSISTED. Default false. |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | New Switch row "Persistent capture notification". On change: start/stop the service via captureNotification.ts and save the setting. |
| `apps/mobile/app.json` | UPDATE | Register the 2 new plugins. Add `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED` to android.permissions. |
| `apps/mobile/plugins/withAppShortcuts.js` | UPDATE | Add `shortcut_audio` to `SHORTCUT_ICON_PATHS` so PR #15's shortcuts also include Audio (currently only 4 — Idea/Journal/Photo/Contact). Tracked as a separate cleanup but landing here since we need the icon anyway. |

## NOT Building
- **iOS support** — Persistent notifications work very differently on iOS (no foreground service equivalent; Live Activities are the closest API and require completely different scaffolding). Out of scope per the Android-first stance.
- **Widget configuration UI** — Users can't pick which 4 actions appear; it's the same 4 the launcher shortcuts use. Customization would need a configuration Activity which is real complexity.
- **Lock-screen visibility toggle** — The notification ships with default `VISIBILITY_PUBLIC` so the actions are visible on the lock screen. A future toggle to hide them is a 3-line addition if users ask.
- **"Continue today's journal" action** — The notification has 4 slots; we mirror the launcher shortcuts. The journal action goes to a new journal entry, not the day's existing one. Could be a 5th action on a stack-collapsing layout later.
- **Auto-start service on app install** — User must flip the Settings toggle on first. Apps can't legally start a foreground service on install without user interaction.
- **Backup-and-restore of the toggle state** — Carnet doesn't ship any settings-sync; this follows the pattern.

---

## Step-by-Step Tasks

### Task 1: Write `withCaptureNotification.js`
- **ACTION:** Create the config plugin.
- **EMITS:** 4 Kotlin files + manifest mutations + package registration in MainApplication.
- **GOTCHA — Android 14 `foregroundServiceType`:** Must declare `specialUse` with a `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property. Without this the service `startForeground()` call throws `ForegroundServiceTypeException` and crashes the app immediately.
- **GOTCHA — `withMainApplication`:** `@expo/config-plugins` exposes `withMainApplication` for Expo SDK 50+. For SDK 54 it works but the file shape changed to Kotlin in SDK 51. Insert the `add(CaptureNotificationPackage())` line after the existing `add(...)` calls inside `MainApplication.getPackages()`.
- **GOTCHA — POST_NOTIFICATIONS perm:** Android 13+ runtime permission. The plugin declares it in the manifest; the JS facade requests it at toggle-on time. Without the perm grant, `startForeground()` succeeds but the notification is silently suppressed.

### Task 2: Write `withCaptureWidget.js`
- **ACTION:** Create the config plugin.
- **EMITS:** 1 Kotlin file + widget layout XML + widget info XML + 1 new drawable (shortcut_audio).
- **GOTCHA — RemoteViews limitations:** Only a fixed set of view types are supported in widget layouts. Use `LinearLayout`, `ImageView`, `TextView`, and clickable child `LinearLayout`s (NOT `Button` — fewer style headaches with RemoteViews). Each clickable cell gets a `setOnClickPendingIntent` in the provider's `onUpdate`.
- **GOTCHA — `widgetCategory`:** Must be `home_screen` (not `keyguard` which would put it on the lock screen — different UX, different reliability).
- **GOTCHA — PendingIntent flags:** Must use `FLAG_IMMUTABLE` on Android 12+. The provider builds 4 PendingIntents with different `requestCode` per mode to prevent collision.

### Task 3: Write `captureNotification.ts` (JS facade)
- **ACTION:** Create the JS-side facade for the native module.
- **EXPOSES:** `start()`, `stop()`, `isRunning()`, `requestPermission()`.
- **WHY:** The Settings screen can't talk to `NativeModules.CaptureNotification` directly without losing type safety; the facade adds runtime checks (module-present? permission-granted?) and a typed API.
- **GOTCHA — module discovery:** `NativeModules.CaptureNotification` will be undefined in two cases: (1) running under Expo Go (no custom native code), (2) the package wasn't registered in MainApplication. The facade must handle the undefined case with a friendly error rather than crashing.

### Task 4: Extend Settings + SettingsScreen
- **ACTION:** Add `persistentNotificationEnabled: boolean` to the Settings shape; add a Switch row to the form.
- **MIRROR:** Existing pattern for `omniRouteTranscriptionModel` from PR #18 — DEFAULT_PERSISTED, FormState, useEffect init, save() field, UI input.
- **GOTCHA — async perm flow:** Flipping the Switch on triggers: (1) save the boolean, (2) request POST_NOTIFICATIONS, (3) call `captureNotification.start()`. If the user denies perm, revert the toggle. The flow must be atomic from the user's view — no half-state where the setting says "on" but the notification isn't showing.

### Task 5: Register plugins + perms in `app.json`
- **ACTION:** Add the two plugins to the plugins array. Add 4 perms to `android.permissions`: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`.
- **GOTCHA — perm order:** Doesn't matter functionally but `expo prebuild` writes them in declared order; keep them grouped logically.

### Task 6: Extend `withAppShortcuts.js` with `shortcut_audio`
- **ACTION:** Add the new audio vector drawable path to `SHORTCUT_ICON_PATHS` so the widget + notification can reference it.
- **NOTE:** This means PR #15's app shortcuts also could be extended with an Audio shortcut, but that's NOT in scope here. Just adding the drawable so this PR's surfaces can reference it.

### Task 7: Write verification script
- **ACTION:** Create `scripts/verify-notification-and-widget-prebuild.sh` mirroring the existing shortcuts script.
- **ASSERTS:** 4 Kotlin files emitted under `notification/`, 1 under `widget/`, 1 layout XML, 1 widget info XML, 1 new drawable, and 3 manifest lines (service, receiver-boot, receiver-widget).
- **WHY:** Catches plugin regressions before they reach a real device. CI doesn't run android prebuild today, but this script is locally-invoked during plugin edits.

### Task 8: Validate + on-device handoff
- **ACTION:** Run `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`. Run the verify script manually (it does a clean prebuild).
- **EXPECT:** 0 type errors. All existing 193 tests still pass (no JS tests added; native code isn't unit-testable in this stack). Verify script reports all 10 emitted files + manifest lines.
- **REBUILD:** `cd apps/mobile && npm run android` (a full rebuild is required because the native module is new — JS-only live-reload won't pick it up).

---

## Testing Strategy

### Unit Tests
Limited. The two new pure functions are:
- `captureNotification.ts`'s facade — could test the "module undefined → friendly error" path, but it requires mocking NativeModules which adds setup complexity without much signal.
- Plugin XML emission — covered by the verify script (integration test, not unit).

No new vitest tests planned. Existing 193 tests verify no regressions.

### Edge Cases Checklist
- [ ] Toggle "Persistent capture notification" ON → POST_NOTIFICATIONS prompt → grant → 4-button notification appears in shade
- [ ] Toggle OFF → notification disappears immediately
- [ ] Tap each of the 4 action buttons → app opens to the correct screen (Idea / Journal capture, Photo capture, Audio capture)
- [ ] Tap the notification body (not an action) → app opens to Home
- [ ] Toggle ON, reboot device → notification re-appears within ~10s of unlock (BootReceiver fires `LOCKED_BOOT_COMPLETED` after unlock)
- [ ] Toggle ON, force-stop carnet from app info → notification disappears (foreground service killed) → reopen carnet → notification reappears (Settings is sticky)
- [ ] Deny POST_NOTIFICATIONS permission → toggle reverts to OFF, error toast surfaces
- [ ] Add widget to home screen → 4 buttons render with icons + labels
- [ ] Tap each widget button → correct deep link fires
- [ ] Long-press widget → "Resize" works (4x1 ↔ 4x2 ish)
- [ ] Theme test: light theme + dark theme both render widget cleanly (system tint handles the foreground)
- [ ] Regression: app shortcuts (PR #15) still appear on long-press launcher icon
- [ ] Regression: existing share intent, deep links, capture flows still work

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 193/193 still pass.

### Plugin output verification
```bash
cd apps/mobile && bash scripts/verify-notification-and-widget-prebuild.sh
```
EXPECT: All emitted files + manifest lines reported present.

### On-device
```bash
cd apps/mobile && npm run android
```
EXPECT: app installs, Settings → new toggle visible, flip on works, widget picker shows carnet entry.

### Manual deep-link sanity
```bash
adb shell am start -W -a android.intent.action.VIEW -d "carnet://capture/idea" us.beary.carnet
adb shell am start -W -a android.intent.action.VIEW -d "carnet://photo" us.beary.carnet
adb shell am start -W -a android.intent.action.VIEW -d "carnet://audio" us.beary.carnet
```
EXPECT: each opens the matching capture screen directly.

---

## Acceptance Criteria
- [ ] Two Expo config plugins emit Kotlin + XML reproducibly via `expo prebuild --clean`
- [ ] Settings toggle starts/stops the foreground service notification
- [ ] All 4 notification actions deep-link to the right screen
- [ ] Widget renders with 4 buttons and each deep-links correctly
- [ ] POST_NOTIFICATIONS perm flow is atomic (no orphaned toggle state)
- [ ] Notification persists across reboot when toggle is on
- [ ] 0 type errors; existing 193 tests still pass
- [ ] Verify script passes — all emitted files + manifest lines present

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Android 14 `foregroundServiceType` misdeclaration crashes service start | Medium | Hard crash on Settings toggle | `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` is the right pick; verified against Android dev docs |
| `withMainApplication` doesn't work on Expo SDK 54 anymore | Medium | RN bridge module unreachable, JS `start()` no-ops | Fallback: emit `MainApplication.kt` via withDangerousMod (full overwrite). Hairier but reliable. Check first; only fall back if needed. |
| POST_NOTIFICATIONS denied → notification silently suppressed but toggle says ON | High without guard | User confused about why nothing's happening | Atomic flow: request perm BEFORE start, revert toggle on deny |
| RemoteViews layout doesn't render on some OEMs (Samsung One UI etc.) | Low-Medium | Widget looks broken on a fraction of devices | Use only Google-spec-blessed views (LinearLayout/ImageView/TextView). Document one-OEM test in the PR if you have access. |
| Boot receiver fires before `MainActivity` has registered its lifecycle | Low | Notification re-posts but tap-actions fail | Service `onCreate` builds notification immediately; doesn't depend on MainActivity. Deep links resolve via the OS's intent dispatcher even if app process is fully cold. |
| Battery telemetry flags the always-on service | Low | User sees carnet in "battery usage" with non-trivial % | Service holds no wake lock, runs no timer, posts no updates. Idle cost is ~0. Document in NOT Building. |
| Play Store rejects `specialUse` foregroundServiceType | High | App can't ship to Play Store | Carnet distributes as sideloaded APK only (PR #13's release script). Play Store path needs a different design (workmanager-based jobs + lock-screen quick settings tile). Out of scope. |
| User installs the APK without granting POST_NOTIFICATIONS at install time | Certain on Android 13+ | Toggle still works, just gates on perm request when flipped | This is the intended UX. Not a risk, an expected flow. |
| Widget update period 0ms makes widget appear stuck | Low | Some launchers (Nova etc.) may not refresh on theme change | Acceptable — the widget content is static. User can remove + re-add if needed. |

## Notes
- This PR is the third Expo config plugin in carnet (after PR #15's shortcuts). The pattern is solidifying — worth a future refactor pass to extract a tiny shared helper for "emit XML files via withDangerousMod with idempotent overwrite + structured logging." Not in scope here.
- The foreground service is the LARGEST native footprint carnet has added. Future native features (sensor access for ambient capture, etc.) can mirror this shape.
- The widget reuses the existing shortcut drawables — adding `shortcut_audio` once benefits both PR #15's shortcuts (when extended) and this PR's widget + notification. Consolidated icon registry pays off.
