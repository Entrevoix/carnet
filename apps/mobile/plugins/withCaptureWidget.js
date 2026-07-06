// ⚠️  CI DOES NOT COMPILE THE KOTLIN BELOW BY DEFAULT.
// The Kotlin (and layout XML) emitted from this file is generated at
// `expo prebuild` time into the gitignored android/ tree. vitest + `tsc --noEmit`
// (the only checks in the required `gate` CI job) never see it, so a Kotlin
// compile error here passes CI and only fails on a real Gradle build. A
// non-blocking `mobile-android` CI job (.github/workflows/ci.yml) runs a real
// prebuild + `:app:compileDebugKotlin`, but until it is promoted into
// `gate.needs`, BEFORE MERGING any change to the Kotlin templates here you MUST
// manually run:
//   cd apps/mobile && npx expo prebuild --clean -p android \
//     && cd android && ./gradlew :app:compileDebugKotlin
// and confirm BUILD SUCCESSFUL. (See withCaptureNotification.js for the B5
// getTaskConfig regression that motivated this warning.)
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
import android.widget.RemoteViews
import ${packageName}.R

/**
 * 4-button home-screen widget. Pure RemoteViews — no JS runs when the
 * user taps, the OS dispatches the PendingIntent directly to MainActivity
 * via the carnet:// deep link.
 *
 * Each cell uses a different requestCode on its PendingIntent so the OS
 * doesn't collapse them into one shared intent.
 */
class CaptureWidgetProvider : AppWidgetProvider() {

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
      appWidgetManager.updateAppWidget(id, views)
    }
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

function widgetCaptureInfoXml() {
  // updatePeriodMillis="0" — content never changes, no need to wake the
  // widget. Older Androids ignore targetCellWidth/Height; minWidth /
  // minHeight cover the fallback.
  return `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="40dp"
    android:targetCellWidth="4"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_capture"
    android:resizeMode="horizontal"
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
