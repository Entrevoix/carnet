#!/usr/bin/env bash
#
# Regression check for the withCaptureNotification + withCaptureWidget
# config plugins.
#
# Runs a clean Android prebuild and asserts that all emitted files land
# where the gradle build can find them, plus the AndroidManifest carries
# the service / receiver / permission declarations the plugins inject.
#
# Same shape as verify-shortcuts-prebuild.sh — cheaper than wiring vitest
# into the plugins/ directory for one round of snapshot tests.
#
# Exit 0 = all good. Non-zero = failures printed before exit.
#
# CAVEAT: nukes apps/mobile/android/ to guarantee a clean prebuild.
# android/ is gitignored and regenerated on every `npm run android`, so
# this is safe — but don't run it concurrently with a Gradle build.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
# Derive the package from app.json so this never goes stale on a rename/rebrand.
PKG="$(node -p "require('$MOBILE_DIR/app.json').expo.android.package")"
PKG_PATH="${PKG//.//}"

cd "$MOBILE_DIR"

echo "→ Cleaning android/ for a fresh prebuild…"
rm -rf "$ANDROID_DIR"

echo "→ Running expo prebuild --platform android…"
npx expo prebuild --platform android >/dev/null

EXIT=0

check_file() {
  local relpath="$1"
  local label="$2"
  if [ -f "$ANDROID_DIR/$relpath" ]; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING: $label ($relpath)"
    EXIT=1
  fi
}

check_manifest_contains() {
  local needle="$1"
  local label="$2"
  if grep -q "$needle" "$ANDROID_DIR/app/src/main/AndroidManifest.xml"; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING in manifest: $label ($needle)"
    EXIT=1
  fi
}

check_main_app_contains() {
  local needle="$1"
  local label="$2"
  local file
  file=$(find "$ANDROID_DIR/app/src/main/java" -name 'MainApplication.kt' -o -name 'MainApplication.java' 2>/dev/null | head -1)
  if [ -z "$file" ]; then
    echo "  ✗ MISSING: MainApplication source file"
    EXIT=1
    return
  fi
  if grep -q "$needle" "$file"; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING in MainApplication: $label ($needle)"
    EXIT=1
  fi
}

echo "→ Notification plugin — emitted Kotlin sources:"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureForegroundService.kt" "CaptureForegroundService.kt"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureNotificationModule.kt" "CaptureNotificationModule.kt"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureNotificationPackage.kt" "CaptureNotificationPackage.kt"
check_file "app/src/main/java/$PKG_PATH/notification/BootReceiver.kt" "BootReceiver.kt"

echo "→ Widget plugin — emitted Kotlin + resources:"
check_file "app/src/main/java/$PKG_PATH/widget/CaptureWidgetProvider.kt" "CaptureWidgetProvider.kt"
check_file "app/src/main/res/layout/widget_capture.xml" "widget_capture.xml (layout)"
check_file "app/src/main/res/xml/widget_capture_info.xml" "widget_capture_info.xml"

echo "→ Shared drawable:"
check_file "app/src/main/res/drawable/shortcut_audio.xml" "shortcut_audio.xml"

echo "→ AndroidManifest declarations:"
check_manifest_contains "CaptureForegroundService" "service: CaptureForegroundService"
check_manifest_contains "foregroundServiceType=\"specialUse\"" "service type: specialUse"
check_manifest_contains "PROPERTY_SPECIAL_USE_FGS_SUBTYPE" "subtype property"
check_manifest_contains "BootReceiver" "receiver: BootReceiver"
check_manifest_contains "CaptureWidgetProvider" "receiver: CaptureWidgetProvider"
check_manifest_contains "android.appwidget.action.APPWIDGET_UPDATE" "widget intent filter"
check_manifest_contains "FOREGROUND_SERVICE_SPECIAL_USE" "permission: FOREGROUND_SERVICE_SPECIAL_USE"
check_manifest_contains "POST_NOTIFICATIONS" "permission: POST_NOTIFICATIONS"
check_manifest_contains "RECEIVE_BOOT_COMPLETED" "permission: RECEIVE_BOOT_COMPLETED"

echo "→ MainApplication package registration:"
check_main_app_contains "import ${PKG}.notification.CaptureNotificationPackage" "import line present"
# Distinct check for the add() injection — earlier versions of the plugin
# only inserted the import but silently failed the add() injection on
# SDK 54's expression-bodied MainApplication. Catching that requires
# checking for the CALL site, not just the symbol name.
check_main_app_contains "add(CaptureNotificationPackage())" "add() call site present (bridge registered)"

if [ "$EXIT" -eq 0 ]; then
  echo
  echo "✓ Notification + widget plugins are healthy — all artifacts present."
else
  echo
  echo "✗ Plugin output is incomplete. Inspect plugins/withCaptureNotification.js"
  echo "  and plugins/withCaptureWidget.js."
fi

exit "$EXIT"
