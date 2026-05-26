#!/usr/bin/env bash
#
# Build a release APK that runs without Metro — JS is bundled inline and the
# APK is installable on any phone. Defaults to the Android debug keystore, so
# the output is sideloadable but NOT Play-Store-ready (different machines
# will produce APKs with different identities and Android will treat them as
# different apps for upgrade purposes).
#
# Sequence:
#   1. Verify the prebuilt android/ folder exists; tell the user to run
#      `npx expo prebuild --platform android` if it doesn't.
#   2. Run `./gradlew assembleRelease` (Gradle handles the JS bundle via the
#      react-native-gradle-plugin tasks wired during prebuild).
#   3. Print the output path.
#   4. If a device is connected, offer to install via adb. Otherwise show
#      the install command.

set -e

# Resolve to apps/mobile regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
OUTPUT_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

# ── locate Android SDK (gradle needs ANDROID_HOME or local.properties) ──
# Without this, gradle's eval phase fails with "SDK location not found"
# before it even gets to the resource merge. Mirrors the adb-locator
# fallback below — the same path serves both needs.
if [ -z "${ANDROID_HOME:-}" ]; then
  for sdk_path in "${HOME}/Android/Sdk" "/opt/android-sdk" "${HOME}/Library/Android/sdk"; do
    if [ -d "$sdk_path" ]; then
      export ANDROID_HOME="$sdk_path"
      echo "Detected ANDROID_HOME=$ANDROID_HOME"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: ANDROID_HOME unset and no SDK found in standard locations." >&2
  echo "Install Android Studio + SDK, or set ANDROID_HOME=/path/to/Android/Sdk and retry." >&2
  exit 1
fi

# ── prebuild check ───────────────────────────────────────────────────
if [ ! -d "$ANDROID_DIR" ]; then
  echo "ERROR: $ANDROID_DIR doesn't exist." >&2
  echo "Run: cd $MOBILE_DIR && npx expo prebuild --platform android" >&2
  exit 1
fi

# ── locate adb (only needed for the optional install at the end) ────
if [ -n "${ANDROID_HOME:-}" ] && [ -x "${ANDROID_HOME}/platform-tools/adb" ]; then
  ADB="${ANDROID_HOME}/platform-tools/adb"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "${ANDROID_SDK_ROOT}/platform-tools/adb" ]; then
  ADB="${ANDROID_SDK_ROOT}/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
  ADB="$(command -v adb)"
elif [ -x "${HOME}/Android/Sdk/platform-tools/adb" ]; then
  ADB="${HOME}/Android/Sdk/platform-tools/adb"
elif [ -x "${HOME}/Library/Android/sdk/platform-tools/adb" ]; then
  ADB="${HOME}/Library/Android/sdk/platform-tools/adb"
else
  ADB=""
fi

# ── build ────────────────────────────────────────────────────────────
echo "Building release APK… (this packages the JS bundle into the APK, no Metro needed)"
( cd "$ANDROID_DIR" && ./gradlew assembleRelease )

if [ ! -f "$OUTPUT_APK" ]; then
  echo "ERROR: build completed but $OUTPUT_APK is missing." >&2
  echo "Check the Gradle output above for a non-fatal-but-suspicious error." >&2
  exit 1
fi

# ── report + offer install ───────────────────────────────────────────
SIZE=$(stat -c %s "$OUTPUT_APK" 2>/dev/null || stat -f %z "$OUTPUT_APK" 2>/dev/null || echo "?")
SIZE_MB=$(( SIZE / 1024 / 1024 ))

echo ""
echo "✓ Built: $OUTPUT_APK  (${SIZE_MB} MB)"
echo ""

if [ -z "$ADB" ]; then
  echo "To install on a connected device:"
  echo "  adb install -r $OUTPUT_APK"
  exit 0
fi

# Detect a connected device. "adb devices" output has a header line + one
# line per device; consider it "connected" only if there's at least one
# line ending in $'\tdevice'.
if "$ADB" devices 2>/dev/null | grep -qE $'\tdevice$'; then
  echo "Installing to the connected device…"
  "$ADB" install -r "$OUTPUT_APK"
  echo "Done. Launch from the app drawer; no Metro needed."
else
  echo "No device connected. To install:"
  echo "  adb install -r $OUTPUT_APK"
fi
