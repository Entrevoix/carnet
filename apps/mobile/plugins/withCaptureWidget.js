// ⚠️  THE KOTLIN BELOW IS INVISIBLE TO THE JS/TS GATES.
// The Kotlin (and layout XML) emitted from this file is generated at
// `expo prebuild` time into the gitignored android/ tree. vitest +
// `tsc --noEmit` never see it, so a Kotlin compile error here sails past both.
//
// It IS gated now: `mobile-android` (.github/workflows/ci.yml) runs a real
// prebuild + `:app:compileDebugKotlin` and was promoted into `gate.needs` on
// 2026-07-09, so a broken template blocks the merge rather than reaching main.
// (This comment previously said it was non-blocking "until promoted" — stale.)
//
// Still run it locally before pushing, for feedback in ~1min instead of ~4:
//   export ANDROID_HOME="$HOME/Android/Sdk"   # prebuild --clean wipes local.properties
//   cd apps/mobile && npx expo prebuild --clean -p android \
//     && cd android && ./gradlew :app:compileDebugKotlin
// and confirm BUILD SUCCESSFUL. (See withCaptureNotification.js for the B5
// getTaskConfig regression that motivated this warning.)
//
// What NO build catches: an unsupported view in a RemoteViews layout compiles
// and packages fine, then throws InflateException on a real home screen. Only
// placing the widget on a device proves the layout works.
//
// TODO(plugin-cleanup): Kotlin + layout XML are embedded as JS strings here
// for expedience. Future refactor: move to plugins/templates/widget/*.{kt,xml}
// and render via __PACKAGE__ placeholder substitution. See the matching TODO
// in withCaptureNotification.js for rationale.
//
// Home-screen widget — 4-button capture row.
//
// Emits an AppWidgetProvider Kotlin class + RemoteViews layout +
// widget-info XML + the receiver declaration in AndroidManifest. Each
// button is a clickable LinearLayout with an ImageView + TextView, wired
// to a PendingIntent that deep-links into carnet's capture screens.
//
// Three modifier stages:
//   1. withAndroidManifest — add <receiver> with APPWIDGET_UPDATE filter.
//   2. withDangerousMod — emit the Kotlin provider class + layout XML +
//      widget info XML + shortcut_audio drawable (also emitted by
//      withCaptureNotification.js for resilience).
//
// No MainApplication injection — the widget is OS-driven via the
// receiver, no JS bridge needed.

const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const {
  SHORTCUT_AUDIO_PATH_DATA,
  buildVectorDrawable,
} = require('./withCaptureNotification');

function captureWidgetProviderKt(packageName) {
  return `package ${packageName}.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.widget.RemoteViews
import ${packageName}.R

/**
 * 4-button home-screen widget, resizable between a 4x1 row and a 2x2 grid.
 * Pure RemoteViews — no JS runs when the user taps, the OS dispatches the
 * PendingIntent directly to MainActivity via the carnet:// deep link.
 *
 * Each cell uses a different requestCode on its PendingIntent so the OS
 * doesn't collapse them into one shared intent.
 *
 * Two sizing paths, because minSdk here is 24:
 *   - API 31+ : hand the OS a size -> RemoteViews map and let it pick, and
 *     re-pick on every resize, with no callback of ours involved.
 *   - API 24-30 : that API does not exist, so onAppWidgetOptionsChanged reads
 *     the launcher's reported width and swaps the layout by hand.
 * The two must never both run — see the guard in onAppWidgetOptionsChanged.
 */
class CaptureWidgetProvider : AppWidgetProvider() {

  companion object {
    /** Below this reported width (dp) the 2x2 grid is used. ~2.5 cells: wide
     * enough that a 3-cell-wide widget still gets the row. */
    private const val WIDE_THRESHOLD_DP = 180
  }

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    appWidgetIds.forEach { id ->
      appWidgetManager.updateAppWidget(id, responsiveViews(context))
    }
  }

  /**
   * Legacy sizing for API 24-30, where RemoteViews(Map<SizeF, RemoteViews>)
   * does not exist. Returns early on 31+ so it cannot fight the OS-driven
   * mapping — running both produces a visible flicker on resize, since each
   * one rebinds the widget.
   */
  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      val minWidth = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
      // 0 means the launcher reported nothing — keep the wide layout rather
      // than treating "unknown" as "narrow", which would flip a freshly
      // placed 4x1 to the square grid.
      val layout =
        if (minWidth in 1 until WIDE_THRESHOLD_DP) R.layout.widget_capture_2x2
        else R.layout.widget_capture
      appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, layout))
    }
    super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
  }

  /**
   * On API 31+ both layouts are handed to the OS at once, keyed by the
   * MINIMUM size each one serves; the OS picks the largest key that fits, so
   * the square's key must be the smaller of the two or it is never chosen.
   * Both are built eagerly — the map is consulted by the OS long after this
   * returns, so a lazily-built entry would capture a stale context.
   */
  private fun responsiveViews(context: Context): RemoteViews {
    val wide = buildViews(context, R.layout.widget_capture)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return wide
    val square = buildViews(context, R.layout.widget_capture_2x2)
    return RemoteViews(
      mapOf(
        SizeF(110f, 110f) to square,
        SizeF(WIDE_THRESHOLD_DP.toFloat(), 40f) to wide,
      ),
    )
  }

  /** Bind the four capture actions into whichever layout was inflated. Both
   * layouts expose the same four ids, so this is layout-agnostic. */
  private fun buildViews(context: Context, layoutId: Int): RemoteViews {
    val views = RemoteViews(context.packageName, layoutId)
    views.setOnClickPendingIntent(
      R.id.btn_idea,
      captureIntent(context, "carnet://capture/idea", 10),
    )
    views.setOnClickPendingIntent(
      R.id.btn_journal,
      captureIntent(context, "carnet://capture/journal", 11),
    )
    views.setOnClickPendingIntent(
      R.id.btn_photo,
      captureIntent(context, "carnet://photo", 12),
    )
    views.setOnClickPendingIntent(
      R.id.btn_audio,
      captureIntent(context, "carnet://audio", 13),
    )
    return views
  }

  private fun captureIntent(
    context: Context,
    uri: String,
    requestCode: Int,
  ): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    return PendingIntent.getActivity(context, requestCode, intent, flags)
  }
}
`;
}

function widgetCaptureLayoutXml() {
  // RemoteViews layout — restricted to the standard widget view set. Four
  // vertical cells (ImageView + label) in a horizontal LinearLayout. The
  // clickable target is the cell itself so the tap area covers icon+label.
  return `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="horizontal"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:padding="8dp"
    android:background="#FAFAF7">

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
            android:src="@drawable/shortcut_idea"
            android:contentDescription="Idea" />
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Idea"
            android:textColor="#0F1115"
            android:textSize="11sp"
            android:layout_marginTop="4dp" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/btn_journal"
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
            android:src="@drawable/shortcut_journal"
            android:contentDescription="Journal" />
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Journal"
            android:textColor="#0F1115"
            android:textSize="11sp"
            android:layout_marginTop="4dp" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/btn_photo"
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
            android:src="@drawable/shortcut_photo"
            android:contentDescription="Photo" />
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Photo"
            android:textColor="#0F1115"
            android:textSize="11sp"
            android:layout_marginTop="4dp" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/btn_audio"
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
            android:src="@drawable/shortcut_audio"
            android:contentDescription="Audio" />
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Audio"
            android:textColor="#0F1115"
            android:textSize="11sp"
            android:layout_marginTop="4dp" />
    </LinearLayout>

</LinearLayout>
`;
}

function widgetCapture2x2LayoutXml() {
  // Same four cells as widgetCaptureLayoutXml, reflowed into a 2x2 grid for a
  // square slot. Nested LinearLayout, NOT ConstraintLayout — RemoteViews only
  // supports a fixed view whitelist, and an unsupported root inflates fine at
  // compile time then throws InflateException on a real home screen.
  //
  // The four ids MUST stay identical to the 4x1 layout: the provider binds by
  // id without knowing which layout it got, so a renamed id would make
  // setOnClickPendingIntent a silent no-op — dead taps, no crash, no log.
  //
  // Rows use layout_weight="1" on height (rather than wrap_content) so the two
  // rows split a square evenly instead of hugging the top.
  const cell = (id, drawable, label) => `        <LinearLayout
            android:id="@+id/${id}"
            android:orientation="vertical"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:gravity="center"
            android:padding="4dp"
            android:background="?android:attr/selectableItemBackground">
            <ImageView
                android:layout_width="28dp"
                android:layout_height="28dp"
                android:src="@drawable/${drawable}"
                android:contentDescription="${label}" />
            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="${label}"
                android:textColor="#0F1115"
                android:textSize="11sp"
                android:layout_marginTop="2dp" />
        </LinearLayout>`;

  const row = (a, b) => `    <LinearLayout
        android:orientation="horizontal"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1">
${a}
${b}
    </LinearLayout>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:padding="8dp"
    android:background="#FAFAF7">

${row(cell('btn_idea', 'shortcut_idea', 'Idea'), cell('btn_journal', 'shortcut_journal', 'Journal'))}

${row(cell('btn_photo', 'shortcut_photo', 'Photo'), cell('btn_audio', 'shortcut_audio', 'Audio'))}

</LinearLayout>
`;
}

function widgetCaptureInfoXml() {
  // updatePeriodMillis="0" — content never changes, no need to wake the
  // widget. Older Androids ignore targetCellWidth/Height; minWidth /
  // minHeight cover the fallback.
  //
  // min* is the FLOOR a launcher will allow, not the default. targetCell*
  // stays 4x1 deliberately: it sets the default drop size on API 31+, and on
  // older launchers the default derives from min*. Lowering min* alone would
  // reshape widgets users have already placed. 110dp ~= 2 cells by the
  // (70 * n - 30) rule; 140dp is the 2-cell OUTER size and rounds up to 3 on
  // some launchers, which would make the square unselectable.
  //
  // minHeight stays at ONE cell (40dp), not 110dp. min* is a floor, so it must
  // admit the SMALLEST supported shape in each axis: 110dp wide (the 2x2) and
  // 40dp tall (the 4x1 row). Setting minHeight=110dp made the widget demand two
  // rows, which on API 24-30 — where targetCellHeight is ignored and the
  // launcher sizes from min* — made the 4x1 layout impossible to place at all,
  // even though the legacy path still renders it. Caught in review 2026-08-05.
  return `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp"
    android:minHeight="40dp"
    android:targetCellWidth="4"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_capture"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:previewLayout="@layout/widget_capture" />
`;
}

module.exports = function withCaptureWidget(config) {
  const packageName = config.android?.package;

  // Stage 1 — manifest receiver.
  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest?.application?.[0];
    if (!application) return cfg;
    if (!Array.isArray(application.receiver)) application.receiver = [];

    const receiverName = `${packageName}.widget.CaptureWidgetProvider`;
    const has = application.receiver.some(
      (r) => r?.$?.['android:name'] === receiverName,
    );
    if (!has) {
      application.receiver.push({
        $: {
          'android:name': receiverName,
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [
              {
                $: {
                  'android:name': 'android.appwidget.action.APPWIDGET_UPDATE',
                },
              },
            ],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.appwidget.provider',
              'android:resource': '@xml/widget_capture_info',
            },
          },
        ],
      });
    }
    return cfg;
  });

  // Stage 2 — emit Kotlin + layout + info + drawable.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const packagePath = packageName.replace(/\./g, '/');
      const javaDir = path.join(
        root,
        'app',
        'src',
        'main',
        'java',
        packagePath,
        'widget',
      );
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(
        path.join(javaDir, 'CaptureWidgetProvider.kt'),
        captureWidgetProviderKt(packageName),
        'utf8',
      );

      const layoutDir = path.join(root, 'app', 'src', 'main', 'res', 'layout');
      fs.mkdirSync(layoutDir, { recursive: true });
      fs.writeFileSync(
        path.join(layoutDir, 'widget_capture.xml'),
        widgetCaptureLayoutXml(),
        'utf8',
      );
      // Both layouts must exist: the provider references R.layout.widget_capture_2x2
      // unconditionally, so omitting this breaks the Kotlin compile, not just
      // the rendering.
      fs.writeFileSync(
        path.join(layoutDir, 'widget_capture_2x2.xml'),
        widgetCapture2x2LayoutXml(),
        'utf8',
      );

      const xmlDir = path.join(root, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'widget_capture_info.xml'),
        widgetCaptureInfoXml(),
        'utf8',
      );

      // shortcut_audio drawable — also emitted by withCaptureNotification.
      // Both plugins emit identical content; last-write-wins is safe.
      const drawableDir = path.join(
        root,
        'app',
        'src',
        'main',
        'res',
        'drawable',
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, 'shortcut_audio.xml'),
        buildVectorDrawable(SHORTCUT_AUDIO_PATH_DATA),
        'utf8',
      );

      return cfg;
    },
  ]);

  return config;
};
