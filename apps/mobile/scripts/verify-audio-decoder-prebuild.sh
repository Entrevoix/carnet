#!/usr/bin/env bash
#
# Regression check for the withAudioDecoder config plugin.
#
# Runs a clean Android prebuild and asserts that all expected artifacts
# land where the gradle build can find them, plus the MainApplication.kt
# bridge registration is present.
#
# Same shape as verify-notification-and-widget-prebuild.sh — cheaper than
# wiring vitest into the plugins/ directory for one round of snapshot
# tests, and crucially also asserts the `add()` call site (not just the
# import) since that's the exact silent-fail mode PR #22 fixed.
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
PKG_PATH="us/beary/carnet"

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

echo "→ Audio decoder plugin — emitted Kotlin sources:"
check_file "app/src/main/java/$PKG_PATH/audiodecoder/AudioDecoderModule.kt" "AudioDecoderModule.kt"
check_file "app/src/main/java/$PKG_PATH/audiodecoder/AudioDecoderPackage.kt" "AudioDecoderPackage.kt"

echo "→ MainApplication package registration:"
check_main_app_contains "import us.beary.carnet.audiodecoder.AudioDecoderPackage" "import line present"
# Distinct check for the add() injection — PR #22 lesson: earlier
# versions of withCaptureNotification only inserted the import but
# silently failed the add() injection on SDK 54's expression-bodied
# MainApplication. Catching that requires checking the CALL site, not
# just the symbol name.
check_main_app_contains "add(AudioDecoderPackage())" "add() call site present (bridge registered)"

if [ "$EXIT" -eq 0 ]; then
  echo
  echo "✓ Audio decoder plugin is healthy — all artifacts present."
else
  echo
  echo "✗ Plugin output is incomplete. Inspect plugins/withAudioDecoder.js."
fi

exit "$EXIT"
