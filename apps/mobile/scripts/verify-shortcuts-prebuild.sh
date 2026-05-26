#!/usr/bin/env bash
#
# Regression check for the withAppShortcuts config plugin.
#
# Runs a clean Android prebuild and asserts that:
#   1. apps/mobile/android/app/src/main/res/xml/shortcuts.xml exists
#   2. All 4 shortcut vector drawables exist
#   3. AndroidManifest.xml contains the <meta-data> line pointing at @xml/shortcuts
#
# Cheaper than wiring vitest into the plugins/ directory for one snapshot
# test. Run after editing plugins/withAppShortcuts.js (or after changing
# app.json's android.package) to confirm the plugin still emits the right
# files where Expo's react-native-gradle-plugin will find them.
#
# Exit code 0 = all good. Non-zero = the failure is printed before exit.
#
# CAVEAT: this nukes apps/mobile/android/ to guarantee a clean prebuild.
# That's fine because android/ is gitignored and regenerated on every
# `npm run android`. Don't run this while a Gradle build is in flight.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"

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

echo "→ Checking emitted resource files:"
check_file "app/src/main/res/xml/shortcuts.xml"             "shortcuts.xml"
check_file "app/src/main/res/values/shortcut_strings.xml"   "shortcut_strings.xml (AAPT requires @string refs)"
check_file "app/src/main/res/drawable/shortcut_idea.xml"    "drawable: idea"
check_file "app/src/main/res/drawable/shortcut_journal.xml" "drawable: journal"
check_file "app/src/main/res/drawable/shortcut_photo.xml"   "drawable: photo"
check_file "app/src/main/res/drawable/shortcut_person.xml"  "drawable: person"

echo "→ Checking AndroidManifest meta-data line:"
if grep -q "android.app.shortcuts" "$ANDROID_DIR/app/src/main/AndroidManifest.xml"; then
  echo "  ✓ <meta-data android:name=\"android.app.shortcuts\" …> present in MainActivity"
else
  echo "  ✗ MISSING: meta-data line in AndroidManifest.xml"
  EXIT=1
fi

if [ "$EXIT" -eq 0 ]; then
  echo
  echo "✓ All shortcut resources present — plugin is healthy."
else
  echo
  echo "✗ Plugin output is incomplete. Inspect plugins/withAppShortcuts.js."
fi

exit "$EXIT"
