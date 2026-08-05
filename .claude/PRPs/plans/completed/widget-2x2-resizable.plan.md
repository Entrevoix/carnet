# Plan: Resizable capture widget (4×1 ↔ 2×2)

Status: shipped

## Summary
Make the existing home-screen capture widget resizable so it can be dropped as
today's 4×1 strip or dragged into a 2×2 square, with a layout tuned for each
shape. One provider, one widget-picker entry, same four capture deep links.

## User Story
As someone capturing from the home screen,
I want the Carnet widget to fit a 2×2 slot as well as a 4×1 strip,
So that it fits my layout instead of forcing a full-width row.

## Problem → Solution
`widget_capture_info.xml` declares `targetCellWidth="4" targetCellHeight="1"`
with `resizeMode="horizontal"`, and `CaptureWidgetProvider` binds one fixed
`R.layout.widget_capture` — a single-row `LinearLayout` of four weighted
buttons. A user with a 2×2 gap on their home screen cannot use the widget at
all, and squeezing the 4-across row into two cells would crush the labels.
→ Declare the widget resizable in both axes and bind a **different RemoteViews
per size**: the existing row at 4×1, a 2×2 grid below a width threshold.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form request)
- **PRD Phase**: N/A
- **Estimated Files**: 3 changed (plugin, verify script, codemap), 0 created —
  see "The generated-code trap" below for why the count is so low.

---

## UX Design

### Before
```
Widget picker:  [ Carnet ]

Placed (4×1 only, horizontal resize):
┌──────────────────────────────────────┐
│  ✎ Idea   ● Journal  ▣ Photo  ♫ Audio│
└──────────────────────────────────────┘

Drag the bottom edge → nothing. Vertical resize is disabled,
and a 2×2 slot cannot host it.
```

### After
```
Widget picker:  [ Carnet ]        ← still one entry

Dropped at 4×1 (unchanged default):
┌──────────────────────────────────────┐
│  ✎ Idea   ● Journal  ▣ Photo  ♫ Audio│
└──────────────────────────────────────┘

Dragged to 2×2 — reflows:
┌─────────────────┐
│  ✎ Idea  ● Jrnl │
│  ▣ Photo ♫ Audio│
└─────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Widget picker | one "Carnet" entry | unchanged | Deliberately not a second entry |
| Default drop size | 4×1 | 4×1 | `targetCellWidth/Height` unchanged — existing placements must not move |
| Horizontal resize | allowed | allowed | unchanged |
| Vertical resize | **blocked** | allowed | `resizeMode="horizontal\|vertical"` |
| Layout at ≥ 4 cells wide | row | row (same XML) | byte-identical to today |
| Layout at < ~3 cells wide | n/a | 2×2 grid | new layout |
| Tap targets | 4 deep links | same 4 | No behaviour change; same URIs, same request codes |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/plugins/withCaptureWidget.js` | all (338) | **The only file that matters.** Kotlin + both XML files are emitted from here as JS strings |
| P0 | `apps/mobile/android/.../widget/CaptureWidgetProvider.kt` | 1–61 | The *generated* output — read to understand shape, never edit |
| P0 | `apps/mobile/android/app/src/main/res/xml/widget_capture_info.xml` | 1–11 | Generated; the attrs this plan changes |
| P1 | `apps/mobile/scripts/verify-notification-and-widget-prebuild.sh` | 80–105 | Artifact checks; gains the new layout |
| P1 | `apps/mobile/android/app/src/main/res/layout/widget_capture.xml` | all | Generated 4×1 layout — the 2×2 mirrors its button structure |
| P2 | `.claude/PRPs/plans/completed/persistent-notification-and-widget.plan.md` | all | How the widget shipped originally; the plugin conventions it set |
| P2 | `apps/mobile/plugins/withCaptureNotification.js` | all | Sibling plugin — same emit-strings-from-JS pattern |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Responsive widget layouts | developer.android.com — App Widgets / "Provide flexible widget layouts" | API 31+: pass `RemoteViews(Map<SizeF, RemoteViews>)`; the OS picks per size with no callback |
| Pre-31 sizing | developer.android.com — `AppWidgetProvider.onAppWidgetOptionsChanged` | API 24–30: read `OPTION_APPWIDGET_MIN_WIDTH`/`MIN_HEIGHT` from the options Bundle and bind manually |
| Cell → dp | Android widget sizing guidance | `70dp × n − 30dp`; 2 cells ≈ 110dp, 4 cells ≈ 250dp — matches today's `minWidth="250dp"` |

GOTCHA: `minSdk` here is **24** (confirmed from the merged manifest; compileSdk
36). The tidy `Map<SizeF, RemoteViews>` API is 31+, so it cannot be the only
path — roughly Android 7–11 devices would get whatever single layout was bound
last. Both paths are required.

---

## Patterns to Mirror

### PLUGIN_EMITS_KOTLIN
```js
// SOURCE: apps/mobile/plugins/withCaptureWidget.js:22-29
// Emits an AppWidgetProvider Kotlin class + RemoteViews layout +
//   2. withDangerousMod — emit the Kotlin provider class + layout XML +
```

### WIDGET_PROVIDER_BIND
```kotlin
// SOURCE: apps/mobile/android/.../CaptureWidgetProvider.kt:22-47
override fun onUpdate(
  context: Context,
  appWidgetManager: AppWidgetManager,
  appWidgetIds: IntArray,
) {
  appWidgetIds.forEach { id ->
    val views = RemoteViews(context.packageName, R.layout.widget_capture)
    views.setOnClickPendingIntent(
      R.id.btn_idea,
      captureIntent(context, "carnet://capture/idea", 10),
    )
    // …journal 11, photo 12, audio 13
    appWidgetManager.updateAppWidget(id, views)
  }
}
```

### DEEP_LINK_INTENT
```kotlin
// SOURCE: apps/mobile/android/.../CaptureWidgetProvider.kt:49-60
private fun captureIntent(context: Context, uri: String, requestCode: Int): PendingIntent {
  val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
    setPackage(context.packageName)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  }
  val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  return PendingIntent.getActivity(context, requestCode, intent, flags)
}
```
Each cell uses a **distinct requestCode** so the OS does not collapse the four
PendingIntents into one. The 2×2 layout reuses the same four ids and codes.

### WIDGET_INFO_XML
```xml
<!-- SOURCE: apps/mobile/android/app/src/main/res/xml/widget_capture_info.xml -->
<appwidget-provider
    android:minWidth="250dp"
    android:minHeight="40dp"
    android:targetCellWidth="4"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_capture"
    android:resizeMode="horizontal"
    android:widgetCategory="home_screen"
    android:previewLayout="@layout/widget_capture" />
```

### VERIFY_SCRIPT_CHECK
```bash
# SOURCE: apps/mobile/scripts/verify-notification-and-widget-prebuild.sh:87-89
check_file "app/src/main/java/$PKG_PATH/widget/CaptureWidgetProvider.kt" "CaptureWidgetProvider.kt"
check_file "app/src/main/res/layout/widget_capture.xml" "widget_capture.xml (layout)"
check_file "app/src/main/res/xml/widget_capture_info.xml" "widget_capture_info.xml"
```

---

## The generated-code trap (read before touching anything)

`apps/mobile/android/**` is **build output**. `withCaptureWidget.js` writes
`CaptureWidgetProvider.kt`, `widget_capture.xml` and `widget_capture_info.xml`
from strings embedded in the plugin, and `expo prebuild --clean` — which CI's
`mobile-android` job and `android:release` both run — regenerates them from
scratch.

Editing the `.kt` or `.xml` directly will appear to work locally right up until
the next prebuild silently reverts it, and CI will never see the change. Every
edit in this plan therefore lands in the **plugin's JS strings**.

The plugin carries its own `TODO(plugin-cleanup)` noting the Kotlin-in-JS-string
arrangement is unpleasant. Do **not** take that on here: it is a refactor of a
working native surface, and mixing it with a behaviour change makes any
regression impossible to bisect.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/plugins/withCaptureWidget.js` | UPDATE | Adds the 2×2 layout string, edits the info-XML string, extends the emitted Kotlin |
| `apps/mobile/scripts/verify-notification-and-widget-prebuild.sh` | UPDATE | Assert the new layout is emitted, and that the info XML declares vertical resize |
| `docs/CODEMAPS/frontend.md` | UPDATE | Note the widget is resizable with two layouts |

No file under `apps/mobile/android/**` is edited by hand. Those change as a
*result* of running prebuild, and the diff there is expected output.

## NOT Building

- **No second widget provider / second picker entry** — decided: one resizable widget.
- **No data in the widget.** No recent-note glance, no counts. The widget stays
  pure RemoteViews with zero runtime reads, so there is nothing to refresh and
  no SAF-permission surface.
- **No change to the four actions or their deep links.**
- **No change to the default drop size** — still 4×1, so existing placements are untouched.
- **No `plugin-cleanup` refactor** of the Kotlin-in-JS-strings arrangement.
- **No notification-plugin changes** — sibling surface, out of scope.
- **No iOS/desktop widget.**

---

## Step-by-Step Tasks

### Task 1: Add the 2×2 layout string to the plugin
- **ACTION**: In `withCaptureWidget.js`, add a second layout constant emitted as
  `res/layout/widget_capture_2x2.xml`.
- **IMPLEMENT**: A 2×2 grid using only [RemoteViews-supported views][rv] — an
  outer vertical `LinearLayout` containing two horizontal `LinearLayout` rows,
  each with two weighted button cells. Reuse the **same four child ids**
  (`btn_idea`, `btn_journal`, `btn_photo`, `btn_audio`) and the same icon +
  label structure as `widget_capture.xml`, so the Kotlin binds identically
  regardless of which layout is inflated.
- **MIRROR**: the existing layout string in the same file (`android:layout_weight="1"` cells).
- **IMPORTS**: none (plain string in JS).
- **GOTCHA**: RemoteViews supports only a fixed view whitelist —
  `LinearLayout`, `FrameLayout`, `RelativeLayout`, `GridLayout`, `TextView`,
  `ImageView`, `Button`, `ProgressBar`, and a few more. **`ConstraintLayout` is
  NOT supported** and fails at inflate time with a runtime
  `android.view.InflateException`, not a compile error — so a wrong choice here
  survives CI and only dies on a real home screen. Nested `LinearLayout` is the
  safe grid.
  Ids MUST match the 4×1 layout: differing ids would make
  `setOnClickPendingIntent` a silent no-op for the missing ones — taps would do
  nothing, with no crash and no log.
- **VALIDATE**: `npx expo prebuild --clean` then confirm
  `android/app/src/main/res/layout/widget_capture_2x2.xml` exists and contains all four ids.

### Task 2: Declare the widget resizable
- **ACTION**: Edit the info-XML string in the plugin.
- **IMPLEMENT**:
  ```xml
  android:minWidth="110dp"       <!-- was 250dp — 2 cells -->
  android:minHeight="110dp"      <!-- was 40dp  — 2 cells -->
  android:targetCellWidth="4"    <!-- unchanged: default drop stays 4×1 -->
  android:targetCellHeight="1"   <!-- unchanged -->
  android:resizeMode="horizontal|vertical"
  ```
  Leave `initialLayout`/`previewLayout` pointing at `@layout/widget_capture`.
- **MIRROR**: WIDGET_INFO_XML.
- **IMPORTS**: none.
- **GOTCHA**: `minWidth`/`minHeight` are the *floor* a launcher permits, not the
  default — `targetCellWidth/Height` set the default on API 31+, and on older
  launchers the default derives from min\*. Lowering minHeight to 110dp without
  keeping targetCell at 4×1 would make fresh drops land 2×2 and quietly reshape
  the widget for anyone who wanted the strip.
  110dp ≈ 2 cells by the `70n − 30` rule; do not use 140dp (that is 2 cells'
  *outer* size and rounds up to 3 on some launchers).
- **VALIDATE**: after prebuild, `widget_capture_info.xml` shows
  `resizeMode="horizontal|vertical"` and `targetCellWidth="4"`.

### Task 3: Bind the right layout per size (API 31+)
- **ACTION**: Extend the emitted Kotlin so `onUpdate` supplies a size→views map
  on Android 12+.
- **IMPLEMENT**: Extract the existing per-view wiring into
  `private fun buildViews(context: Context, layoutId: Int): RemoteViews` holding
  the four `setOnClickPendingIntent` calls, then:
  ```kotlin
  private fun remoteViewsFor(context: Context): RemoteViews {
    val wide = buildViews(context, R.layout.widget_capture)
    val square = buildViews(context, R.layout.widget_capture_2x2)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // The OS picks per size and re-picks on resize — no callback needed.
      RemoteViews(mapOf(SizeF(180f, 40f) to wide, SizeF(110f, 110f) to square))
    } else {
      wide
    }
  }
  ```
- **MIRROR**: WIDGET_PROVIDER_BIND — keep `captureIntent` and its request codes
  (10/11/12/13) exactly as they are.
- **IMPORTS**: `android.os.Build`, `android.util.SizeF`.
- **GOTCHA**: Build **both** RemoteViews eagerly; the map is evaluated by the OS
  later, and a lazily-built one would capture a stale context. The map's SizeF
  keys are the *minimum* size each layout serves, in dp, and the OS picks the
  largest key that fits — so the smallest key must be the 2×2, or the square
  layout is never chosen. This is pure Kotlin inside a JS template string:
  mind `$` escaping, since `${...}` in the emitted Kotlin would be interpolated
  by JS at plugin-run time. There is no Kotlin string interpolation in this
  file today — keep it that way.
- **VALIDATE**: `npm -w @carnet/mobile run android` (a real build — see
  Validation) compiles `:app:compileDebugKotlin`.

### Task 4: Pre-31 fallback via `onAppWidgetOptionsChanged`
- **ACTION**: Add the override so API 24–30 devices still reflow on resize.
- **IMPLEMENT**:
  ```kotlin
  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return  // OS handles it
    val minWidth = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val layout =
      if (minWidth in 1 until WIDE_THRESHOLD_DP) R.layout.widget_capture_2x2
      else R.layout.widget_capture
    appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, layout))
    super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
  }
  ```
  with `private const val WIDE_THRESHOLD_DP = 180` in a `companion object`.
- **MIRROR**: the provider's existing override style (explicit params, no `!!`).
- **IMPORTS**: `android.os.Bundle`.
- **GOTCHA**: Guard on `SDK_INT >= S` and return early — without it, this
  override fights the API 31+ responsive map and produces a flicker on resize,
  because both try to own the binding. `minWidth == 0` means the launcher
  reported nothing; treat that as "keep wide" (hence `in 1 until`), not as
  "narrow", or a widget can flip to 2×2 the instant it is placed.
- **VALIDATE**: compiles; behavioural check is the device pass.

### Task 5: Extend the prebuild verify script
- **ACTION**: Add artifact assertions.
- **IMPLEMENT**: a `check_file` for
  `app/src/main/res/layout/widget_capture_2x2.xml`, plus a grep asserting
  `widget_capture_info.xml` contains `horizontal|vertical`.
- **MIRROR**: VERIFY_SCRIPT_CHECK.
- **IMPORTS**: none.
- **GOTCHA**: This script proves the plugin **emitted** the files. It cannot
  prove the Kotlin compiles or the layout inflates — see the Validation section.
  Do not let a green verify script stand in for a build.
- **VALIDATE**: `bash apps/mobile/scripts/verify-notification-and-widget-prebuild.sh`.

### Task 6: Update the codemap
- **ACTION**: Note in `docs/CODEMAPS/frontend.md` that the capture widget is
  resizable 4×1 ↔ 2×2 with two emitted layouts, and that both come from
  `plugins/withCaptureWidget.js`.
- **MIRROR**: the existing widget/notification sentences there.
- **VALIDATE**: read it back; no command.

---

## Testing Strategy

### Unit Tests
**None are possible for this change, and that is worth stating plainly.** The
whole surface is emitted native code: the repo's vitest suites cover
`apps/mobile/src/**` TypeScript, and there is no JVM/Robolectric harness for
`app/src/main/java`. The four capture deep links this widget fires are already
covered by the existing linking tests; nothing this plan adds is reachable from
TypeScript.

Confidence therefore comes from three places, in ascending order of strength:

| Level | What it proves | What it misses |
|---|---|---|
| `verify-…-prebuild.sh` | The plugin emitted the expected files | Whether they compile or inflate |
| CI `mobile-android` | The emitted Kotlin **compiles** | Whether the layout inflates or reflows |
| Device pass | It actually works | — |

### Edge Cases Checklist
- [ ] Widget already placed at 4×1 before upgrade → must not reshape or lose its taps
- [ ] Resize 4×1 → 2×2 → back to 4×1 (layout must survive a round trip)
- [ ] API 31+ path (Pixel 9, Android 17) — OS-driven
- [ ] Pre-31 path — `onAppWidgetOptionsChanged`; **needs an API 24–30 device or emulator**
- [ ] All four taps fire the right deep link **in the 2×2 layout** (distinct request codes)
- [ ] Reboot with a 2×2 placed (provider is re-created; binding must be re-applied)
- [ ] Launcher that ignores `targetCell*` (some OEM launchers) → still usable

---

## Validation Commands

### Static / emit check
```bash
cd apps/mobile && npx expo prebuild --clean --platform android
bash apps/mobile/scripts/verify-notification-and-widget-prebuild.sh
```
EXPECT: all artifacts present, including `widget_capture_2x2.xml`.

### Compile the emitted Kotlin — MANDATORY
```bash
npm -w @carnet/mobile run android            # or android:release
```
EXPECT: `:app:compileDebugKotlin` succeeds.

This is the step that catches a typo in the Kotlin-inside-a-JS-string. The
prebuild script above will happily emit Kotlin that does not compile — it only
checks that files exist. CI's `mobile-android` job runs exactly this and is in
`gate.needs`, so a broken emit blocks the merge.

### JS/TS gates (unchanged surface, run for regressions)
```bash
npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile test
```
EXPECT: no change — this plan touches no TypeScript.

### Manual Validation (device — the only real proof)
- [ ] Long-press home → widget picker shows **one** "Carnet" entry
- [ ] Drop it → lands 4×1, looks exactly as it does today
- [ ] Drag the bottom edge → reflows to the 2×2 grid, labels legible, nothing clipped
- [ ] Tap each of the four cells in 2×2 → correct capture screen each time
- [ ] Resize back to 4×1 → row layout returns, taps still work
- [ ] Reboot with a 2×2 placed → still renders and still taps through
- [ ] An existing 4×1 placed *before* this build → unchanged after upgrade
- [ ] Both light and dark home-screen wallpapers (widget bg contrast) — see `DESIGN.md`

---

## Acceptance Criteria
- [ ] All six tasks complete
- [ ] `verify-notification-and-widget-prebuild.sh` passes
- [ ] CI `mobile-android` green (proves the emitted Kotlin compiles)
- [ ] Device: 4×1 → 2×2 → 4×1 round trip works, all four taps correct in both
- [ ] Default drop size still 4×1; pre-existing placements unchanged
- [ ] No file under `apps/mobile/android/**` hand-edited

## Completion Checklist
- [ ] All native changes made in `plugins/withCaptureWidget.js`, not in generated output
- [ ] Same four ids + request codes in both layouts
- [ ] No `ConstraintLayout` (unsupported by RemoteViews)
- [ ] Pre-31 fallback guarded so it cannot fight the 31+ path
- [ ] Codemap updated
- [ ] Plan `Status:` → `shipped` and moved to `plans/completed/` on merge (CI enforces)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Editing generated `android/**` instead of the plugin; prebuild reverts it | **High** | High | "Generated-code trap" section; verify script; a hand-edit vanishes on the next CI prebuild |
| Unsupported view in the 2×2 layout → runtime `InflateException` | Medium | High | Nested `LinearLayout` only; device pass is the sole detector — it compiles fine |
| Mismatched ids between layouts → taps silently dead | Medium | High | Same four ids mandated in Task 1; device pass taps all four in 2×2 |
| Pre-31 path untested (no API 24–30 device on the rig) | **High** | Medium | Flagged in edge cases; needs an emulator. Consider shipping 31+-only and letting older devices keep the 4×1 if no emulator is available |
| Lowering `minHeight` reshapes existing placements | Low | High | `targetCellWidth/Height` deliberately unchanged; explicit device check on a pre-existing widget |
| Kotlin `${...}` accidentally interpolated by the JS template string | Medium | Medium | Task 3 GOTCHA; the compile step catches it |
| Scope creep into the `plugin-cleanup` TODO | Medium | Medium | Explicitly in NOT Building |

## Notes
- **Why one resizable widget rather than a second provider:** decided with the
  user. One picker entry, one manifest receiver, no migration story. The cost is
  the dual-path binding (31+ map / pre-31 callback) that a fixed-size second
  provider would avoid entirely — if the pre-31 path proves troublesome without
  an emulator to test it on, shipping 31+-only and leaving older devices on the
  4×1 is a reasonable fallback and a one-line change.
- **Why the widget stays data-free:** it reads nothing at runtime, so there is no
  refresh cycle, no `updatePeriodMillis` cost, and no SAF permission question.
  That is what keeps this a layout change rather than a feature.
- The four deep links (`carnet://capture/idea`, `carnet://capture/journal`,
  `carnet://photo`, `carnet://audio`) are unchanged and already handled; this
  plan adds no new routes.
- **`apps/mobile/android/` is gitignored** (`.gitignore:15`). The generated
  Kotlin and XML are not tracked at all, so a hand-edit there is worse than
  reverted-on-next-prebuild: it is invisible to git, cannot be reviewed, cannot
  be committed, and exists only on the machine that made it. CI regenerates the
  whole directory from the plugin on every run. This is why the plan's file
  count is 3 — the plugin **is** the native source.

---

## Implementation record (2026-08-05)

Shipped as planned — no deviations from the six tasks. Three things the plan
did not anticipate:

1. **`prebuild --clean` wipes `local.properties`**, so the compile command the
   plugin header had documented for months fails immediately with "SDK location
   not found". Needs `export ANDROID_HOME="$HOME/Android/Sdk"` first. Both the
   header and this plan's validation section now say so.
2. **The plugin header was stale.** It warned that `mobile-android` was
   non-blocking "until it is promoted into `gate.needs`" — it was promoted
   2026-07-09 (`gate.needs: [shared, mobile, mobile-android, mdcrm]`), so the
   comment was telling editors CI would not catch a broken Kotlin template when
   in fact it does. Corrected.
3. **The codemaps documented neither native surface.** No mention of the widget
   or the notification plugin anywhere in `docs/CODEMAPS/`, so
   `frontend.md` gained a section covering both, the generated-code trap, and
   the verification ladder.

**Evidence obtained without placing the widget:** `dumpsys appwidget` reports
the registered provider at `resizeMode=3` (`RESIZE_HORIZONTAL|RESIZE_VERTICAL`,
was `1`) with `min=(28161x28161)` (was `64001x10241`) — i.e. both attribute
changes reached the system, not just the emitted XML. The stale pre-rename
`com.ventoux.carnet` package still on the device provides a clean control at
`resizeMode=1`.

**Still unproven at merge:** the 2×2 layout inflating, and taps in it. Widget
placement is a launcher drag-and-drop that resists automation, and it is the
only rung that catches an unsupported RemoteViews view — which compiles and
packages cleanly, then throws `InflateException` on a real home screen. Nested
`LinearLayout` was chosen to avoid that class of failure by construction.

**Shipped untested:** the API 24–30 `onAppWidgetOptionsChanged` path. Both
devices on the rig run Android 17, so it has nothing to execute on. Reverting to
31+-only (older devices keep the 4×1) remains a one-line change.
