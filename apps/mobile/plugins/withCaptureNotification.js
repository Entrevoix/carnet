// TODO(plugin-cleanup): Kotlin templates are embedded as JS strings here
// for expedience. Future refactor: move to plugins/templates/notification/*.kt
// and render via __PACKAGE__ placeholder substitution. Defer until we have a
// real reason to edit one of these files — current cost is grep+edit, no
// behavior gain from extracting now.
//
// Persistent capture notification — foreground-service-backed.
//
// Emits the Kotlin sources + manifest declarations + MainApplication
// package registration needed for a "Pull down notification shade →
// 4-button quick capture" surface that survives reboot.
//
// Three modifier stages:
//   1. withAndroidManifest — add <service>, <receiver>, and 4 permissions.
//      Idempotent — won't double-add on re-prebuild.
//   2. withMainApplication — inject `add(CaptureNotificationPackage())`
//      into the React getPackages() return list so the RN bridge module
//      is discoverable from JS.
//   3. withDangerousMod — write the actual Kotlin files + audio icon
//      drawable into android/app/src/main/java/{...}/notification/ and
//      android/app/src/main/res/drawable/.
//
// The service uses foregroundServiceType="specialUse" because the standard
// Android 14+ service types (dataSync, mediaPlayback, ...) don't fit a
// "UI-shortcut notification" use case. specialUse + the property tag is
// the right pick for sideloaded apps. Play Store path would need different
// design (see plan).
//
// All emitted Kotlin lives under us.beary.carnet.notification.* — that
// package path is built from app.json's android.package so a rebrand /
// fork doesn't silently break the manifest references.

const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins');

// graphic_eq Material icon — audio waveform bars. Visually distinct from
// shortcut_journal's microphone (which represents voice-to-text capture,
// not raw audio).
const SHORTCUT_AUDIO_PATH_DATA =
  'M7,18h2L9,6L7,6v12zM11,22h2L13,2h-2v20zM3,14h2v-4L3,10v4zM15,18h2L17,6h-2v12zM19,10v4h2v-4h-2z';
const PRIMARY_COLOR = '#5E63FF';

function buildVectorDrawable(pathData) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="${PRIMARY_COLOR}"
      android:pathData="${pathData}" />
</vector>
`;
}

function captureForegroundServiceKt(packageName) {
  return `package ${packageName}.notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import ${packageName}.R

/**
 * Foreground service that hosts a persistent 4-button capture notification.
 *
 * One channel ("carnet_capture", IMPORTANCE_LOW — no sound/vibration). The
 * notification is built once on start; it never updates because the buttons
 * are static (deep-link targets don't change). The service idles after
 * startForeground() — no wake locks, no timers, no listeners.
 *
 * Stop path: a second startService with action = ACTION_STOP. The module
 * calls this when the user flips the Settings toggle off.
 */
class CaptureForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "carnet_capture"
    const val NOTIFICATION_ID = 1042
    const val ACTION_STOP = "${packageName}.CAPTURE_STOP"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    ensureChannel()
    startForeground(NOTIFICATION_ID, buildNotification())
    // START_STICKY so the OS re-creates the service if it kills it for
    // resources — the user opted into "always available" by flipping the
    // toggle on, and the service costs nothing while idle.
    return START_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Capture",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Persistent quick-capture shortcuts"
        setShowBadge(false)
      }
      val mgr = getSystemService(NotificationManager::class.java)
      mgr?.createNotificationChannel(channel)
    }
  }

  private fun captureIntent(uri: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    // FLAG_IMMUTABLE is mandatory on Android 12+ for PendingIntents that
    // don't need post-creation mutation. UPDATE_CURRENT keeps the same
    // PendingIntent slot but refreshes the embedded Intent extras.
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    return PendingIntent.getActivity(this, requestCode, intent, flags)
  }

  private fun buildNotification(): Notification {
    val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("carnet://")).apply {
      setPackage(packageName)
    }
    val launchPi = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.shortcut_idea)
      .setContentTitle("Carnet")
      .setContentText("Quick capture")
      .setContentIntent(launchPi)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(R.drawable.shortcut_idea, "Idea", captureIntent("carnet://capture/idea", 1))
      .addAction(R.drawable.shortcut_journal, "Journal", captureIntent("carnet://capture/journal", 2))
      .addAction(R.drawable.shortcut_photo, "Photo", captureIntent("carnet://photo", 3))
      .addAction(R.drawable.shortcut_audio, "Audio", captureIntent("carnet://audio", 4))
      .build()
  }
}
`;
}

function captureNotificationModuleKt(packageName) {
  return `package ${packageName}.notification

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * RN bridge for the capture notification. start() launches the foreground
 * service and persists the toggle state to native SharedPreferences;
 * BootReceiver reads that prefs slot to decide whether to re-launch on
 * boot. AsyncStorage's SQLite-backed data isn't accessible from a
 * BroadcastReceiver's short-lived context, so we keep a parallel native
 * flag.
 */
class CaptureNotificationModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val PREFS_NAME = "carnet_native"
    const val KEY_ENABLED = "persistent_notification_enabled"
  }

  override fun getName() = "CaptureNotification"

  @ReactMethod
  fun start(promise: Promise) {
    val ctx = reactApplicationContext
    val intent = Intent(ctx, CaptureForegroundService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_ENABLED, true)
        .apply()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_START_FAIL", e.message ?: "Failed to start service", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val ctx = reactApplicationContext
    val intent = Intent(ctx, CaptureForegroundService::class.java).apply {
      action = CaptureForegroundService.ACTION_STOP
    }
    try {
      ctx.startService(intent)
      ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_ENABLED, false)
        .apply()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_STOP_FAIL", e.message ?: "Failed to stop service", e)
    }
  }

  @ReactMethod
  fun isEnabled(promise: Promise) {
    val enabled = reactApplicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getBoolean(KEY_ENABLED, false)
    promise.resolve(enabled)
  }
}
`;
}

function capturePackageKt(packageName) {
  return `package ${packageName}.notification

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/** ReactPackage registration for the CaptureNotification native module. */
class CaptureNotificationPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CaptureNotificationModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
`;
}

function bootReceiverKt(packageName) {
  return `package ${packageName}.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restarts the capture notification service after device boot — but only
 * if the user previously enabled it (persisted in native SharedPreferences
 * by CaptureNotificationModule).
 *
 * Listens to ACTION_BOOT_COMPLETED (post-unlock) AND
 * LOCKED_BOOT_COMPLETED (pre-unlock, direct-boot aware). The latter
 * delivers earlier on Android 7+. We don't care about pre-unlock UI;
 * either trigger is fine.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED &&
        action != "android.intent.action.LOCKED_BOOT_COMPLETED" &&
        action != "android.intent.action.QUICKBOOT_POWERON") {
      return
    }
    val prefs = context.getSharedPreferences(
      CaptureNotificationModule.PREFS_NAME,
      Context.MODE_PRIVATE,
    )
    if (!prefs.getBoolean(CaptureNotificationModule.KEY_ENABLED, false)) return

    val serviceIntent = Intent(context, CaptureForegroundService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(serviceIntent)
      } else {
        context.startService(serviceIntent)
      }
    } catch (e: Exception) {
      // Best-effort — boot context restrictions on Android 14+ may reject
      // the start. Log at WARN so devs can adb-logcat -s CarnetBoot:* to
      // diagnose "notification disappeared after reboot" reports.
      android.util.Log.w("CarnetBoot", "Boot restore failed: \${e.message}")
    }
  }
}
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = function withCaptureNotification(config) {
  const packageName = config.android?.package;

  // Stage 1 — manifest.
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest) return cfg;

    // Permissions.
    const required = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.RECEIVE_BOOT_COMPLETED',
    ];
    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = [];
    }
    required.forEach((perm) => {
      const has = manifest['uses-permission'].some(
        (u) => u?.$?.['android:name'] === perm,
      );
      if (!has) {
        manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    });

    const application = manifest.application?.[0];
    if (!application) return cfg;

    // Service.
    if (!Array.isArray(application.service)) application.service = [];
    const serviceName = `${packageName}.notification.CaptureForegroundService`;
    const hasService = application.service.some(
      (s) => s?.$?.['android:name'] === serviceName,
    );
    if (!hasService) {
      application.service.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        property: [
          {
            $: {
              'android:name':
                'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': 'capture_shortcut_notification',
            },
          },
        ],
      });
    }

    // Boot receiver.
    if (!Array.isArray(application.receiver)) application.receiver = [];
    const receiverName = `${packageName}.notification.BootReceiver`;
    const hasReceiver = application.receiver.some(
      (r) => r?.$?.['android:name'] === receiverName,
    );
    if (!hasReceiver) {
      application.receiver.push({
        $: {
          'android:name': receiverName,
          'android:exported': 'true',
          'android:enabled': 'true',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              {
                $: {
                  'android:name':
                    'android.intent.action.LOCKED_BOOT_COMPLETED',
                },
              },
              {
                $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' },
              },
            ],
          },
        ],
      });
    }

    return cfg;
  });

  // Stage 2 — MainApplication.kt package registration.
  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const importLine = `import ${packageName}.notification.CaptureNotificationPackage`;
    const addLine = 'packages.add(CaptureNotificationPackage())';

    if (!contents.includes(importLine)) {
      // Insert the import after the last existing top-level import.
      contents = contents.replace(
        /(^import [^\n]+\n)(?![\s\S]*^import [^\n]+\n)/m,
        `$1${importLine}\n`,
      );
    }

    if (!contents.includes('CaptureNotificationPackage()')) {
      // Kotlin MainApplication uses `PackageList(this).packages` and
      // returns it from getPackages(). Insert our add() right after the
      // PackageList line so we contribute to the same return value.
      let inserted = contents.replace(
        /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
        `$1            ${addLine}\n`,
      );
      if (inserted === contents) {
        // Alternate shape — getPackages override returning a mutable list.
        inserted = contents.replace(
          /(override fun getPackages\(\):[^{]*\{[^\n]*\n\s*val packages[^\n]*\n)/,
          `$1            ${addLine}\n`,
        );
      }
      contents = inserted;
    }

    // Postcondition: silent regex misses produce a manifest+kotlin tree
    // that LOOKS healthy but the RN bridge module is unreachable. Fail
    // prebuild loudly with a pointer to what needs updating.
    if (!contents.includes('CaptureNotificationPackage()')) {
      throw new Error(
        '[withCaptureNotification] Failed to inject `add(CaptureNotificationPackage())` ' +
          'into MainApplication.kt. Expected one of: ' +
          '(a) `val packages = PackageList(this).packages` line, ' +
          '(b) `override fun getPackages()` followed by `val packages` declaration. ' +
          'Neither pattern matched — update the plugin for this Expo SDK MainApplication shape.',
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  // Stage 3 — emit Kotlin sources + drawable.
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
        'notification',
      );
      fs.mkdirSync(javaDir, { recursive: true });

      fs.writeFileSync(
        path.join(javaDir, 'CaptureForegroundService.kt'),
        captureForegroundServiceKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'CaptureNotificationModule.kt'),
        captureNotificationModuleKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'CaptureNotificationPackage.kt'),
        capturePackageKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'BootReceiver.kt'),
        bootReceiverKt(packageName),
        'utf8',
      );

      // shortcut_audio drawable — referenced by both this plugin and the
      // widget plugin. Both plugins emit it identically so removing one
      // doesn't strand the other.
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

// Exported for the verify script + the widget plugin to share.
module.exports.SHORTCUT_AUDIO_PATH_DATA = SHORTCUT_AUDIO_PATH_DATA;
module.exports.buildVectorDrawable = buildVectorDrawable;
// Silence the unused-helper lint — escapeXml is exported for parity with
// withAppShortcuts.js even if this plugin doesn't currently interpolate
// any user-controlled strings into XML.
module.exports.escapeXml = escapeXml;
