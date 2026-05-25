# Implementation Report: Persistent notification + home-screen widget (slate #2)

## Summary
Two new always-on Android capture surfaces. (1) A foreground-service-backed persistent notification with 4 action buttons (Idea / Journal / Photo / Audio) that survives reboot via BootReceiver. (2) A 4-cell home-screen widget with the same 4 buttons. Both fire carnet's existing `carnet://` deep links — zero new screens, just new entry points. Shipped behind two reproducible Expo config plugins that materialize on every `expo prebuild --clean`.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Confidence | 6/10 | 8/10 — plan risks (foregroundServiceType, MainApplication injection) all landed working on first try, verified end-to-end via prebuild script |
| Files Changed | ~12 new + 2 modified | 5 new + 4 modified |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Write `withCaptureNotification.js` | Complete | Emits 4 Kotlin files + manifest mods + MainApplication injection |
| 2 | Write `withCaptureWidget.js` | Complete | Emits Kotlin provider + layout XML + info XML, reuses shortcut drawables |
| 3 | Write `captureNotification.ts` JS facade | Complete | NativeModule wrapper + permission flow via PermissionsAndroid (no expo-notifications dep added) |
| 4 | Extend Settings + SettingsScreen | Complete | Switch row + reconcile-on-mount + self-save handler |
| 5 | Register plugins + perms in `app.json` | Complete | 2 plugins + 4 new permissions |
| 6 | Extend `withAppShortcuts.js` with shortcut_audio | Skipped | Audio icon emission moved into each consuming plugin instead — keeps PR #15 untouched |
| 7 | Write verify script | Complete | Clean prebuild + 21 assertions, all pass |
| 8 | Validate (typecheck + tests + verify) | Complete | 0 type errors, 204/204 tests pass (+11 new), verify script green |
| 9 | Devil's advocate review | Complete | 7 action items applied — see "Review fixes applied" section |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` clean |
| Unit Tests | Pass | 204/204 (was 193; +11 captureNotification facade tests) |
| Plugin Integration | Pass | `verify-notification-and-widget-prebuild.sh` — 21 assertions across emitted files + manifest + MainApplication injection |
| Build | N/A | Native rebuild required for on-device test (gradle build via `npm run android`) |
| On-Device | **PENDING** | Cannot run from here — Android device or emulator required for full QA |

## Files Changed

### New
| File | Lines | Purpose |
|---|---|---|
| `apps/mobile/plugins/withCaptureNotification.js` | +371 | Emits Kotlin service + module + package + boot receiver; manifest + MainApplication injection |
| `apps/mobile/plugins/withCaptureWidget.js` | +247 | Emits Kotlin provider + RemoteViews layout + appwidget-info XML |
| `apps/mobile/src/lib/captureNotification.ts` | +80 | JS-side facade for the native bridge |
| `apps/mobile/src/lib/captureNotification.test.ts` | +95 | 11 facade tests (Expo Go / iOS / missing module / perm paths) |
| `apps/mobile/scripts/verify-notification-and-widget-prebuild.sh` | +106 | Plugin output regression check |

### Modified
| File | Action | Notes |
|---|---|---|
| `apps/mobile/src/lib/settings.ts` | UPDATE +12 | New `persistentNotificationEnabled` field + migration |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE +93 | Switch row, reconcile-on-mount, self-saving handler |
| `apps/mobile/app.json` | UPDATE +6 | 2 plugins + 4 perms |

## Review fixes applied (devil's advocate, 7 of 8)

1. **Toggle-Save race fix** — `handleToggleNotification` writes to AsyncStorage immediately via `saveSettings(...)`, no longer relies on the Save button
2. **MainApplication postcondition** — throws with a useful pointer if neither regex matched, preventing silent injection misses
3. **Settings-mount reconcile** — if native flag is ON but POST_NOTIFICATIONS is denied, force-stop the service and render the toggle off
4. **BootReceiver logcat** — `Log.w("CarnetBoot", ...)` on exception swallow for "notification didn't return after reboot" debugging
5. **Settings.ts comment tightened** — explicit "JS is hint-only, native is source of truth"
6. **Plugin TODO headers** — pointing to eventual Kotlin-template extraction
7. **captureNotification facade unit tests** — 11 cases covering iOS / Expo Go / missing module / permission paths

The 8th item (a comment in `app.json` permissions) was dropped because JSON doesn't allow comments.

## Deviations from Plan
- Skipped extending `withAppShortcuts.js` with shortcut_audio. Both new plugins emit the drawable directly (idempotent — last-write-wins is safe with identical content). Leaves PR #15 untouched.
- Used built-in `PermissionsAndroid` instead of adding `expo-notifications` as a new dependency for the POST_NOTIFICATIONS prompt. Same functionality, no new package weight.

## Issues Encountered
- LSP repeatedly flagged the CommonJS plugin files as "could be ESM" — false alarm, Expo config plugins must be CommonJS. No action taken.
- The slop-warning hook fired on a fallback-flavored permission check in the JS facade; revised the code to drop the fallback (load-bearing version check kept).

## On-Device QA Checklist (REQUIRED — cannot run from here)
- [ ] Settings → "Persistent capture notification" Switch appears with bell-ring icon
- [ ] Toggle ON → POST_NOTIFICATIONS prompt → grant → 4-button row appears in notification shade
- [ ] Tap each notification action → app opens to the correct capture screen (Idea/Journal/Photo/Audio)
- [ ] Toggle OFF → notification disappears
- [ ] Toggle ON, reboot device → notification re-appears within ~10s of unlock
- [ ] Toggle ON, deny perm in system settings, reopen carnet Settings → toggle reconciles to OFF (service force-stopped)
- [ ] Long-press home screen → Widgets → carnet entry visible → drop widget on screen
- [ ] Tap each widget button → correct deep link fires
- [ ] Long-press widget → resize works
- [ ] Theme: widget renders cleanly in light + dark modes
- [ ] Regression: PR #15 app shortcuts still work
- [ ] Regression: existing share intent + capture flows still work
- [ ] Regression: PR #18 audio transcription still works

## Next Steps
- [ ] On-device QA against the checklist above
- [ ] `/prp-commit` then `/prp-pr` once QA passes
- [ ] Optional follow-up: extract Kotlin templates from JS strings into `plugins/templates/`
- [ ] Optional follow-up: add 5th audio shortcut to PR #15's launcher long-press shortcuts (now that shortcut_audio drawable exists)
