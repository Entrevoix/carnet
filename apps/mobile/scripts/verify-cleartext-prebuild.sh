#!/usr/bin/env bash
#
# Regression check for the withCleartextLocalProviders config plugin (#153).
#
# Runs a clean Android prebuild and asserts that AndroidManifest.xml's
# <application> element carries android:usesCleartextTraffic="true" — the
# attribute that makes plain-http-to-local-providers (Relais at
# http://127.0.0.1:8080, LAN Ollama) behave identically on every Android
# version instead of depending on the platform's default cleartext policy,
# which was device-verified to differ between a Pixel release build and an
# API 35 emulator running the same APK.
#
# Cheaper than wiring vitest into plugins/ for one attribute assertion —
# same rationale as the sibling verify-*-prebuild.sh scripts.
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
MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"

cd "$MOBILE_DIR"

echo "→ Cleaning android/ for a fresh prebuild…"
rm -rf "$ANDROID_DIR"

echo "→ Running expo prebuild (android only)…"
npx expo prebuild --platform android --no-install >/dev/null

echo "→ Asserting the manifest allows cleartext…"
if [ ! -f "$MANIFEST" ]; then
  echo "✗ FAIL: $MANIFEST was not generated"
  exit 1
fi

if ! grep -q 'android:usesCleartextTraffic="true"' "$MANIFEST"; then
  echo "✗ FAIL: android:usesCleartextTraffic=\"true\" missing from the manifest."
  echo "  The Relais preset (http://127.0.0.1:8080) and LAN http:// providers"
  echo "  will fail on Android versions whose default policy blocks loopback"
  echo "  cleartext — see issue #153."
  exit 1
fi

# The attribute must be on <application>, not some nested element.
if ! tr -d '\n' < "$MANIFEST" | grep -q '<application[^>]*android:usesCleartextTraffic="true"'; then
  echo "✗ FAIL: usesCleartextTraffic=\"true\" present but not on <application>."
  exit 1
fi

echo "✓ withCleartextLocalProviders verified: manifest permits cleartext on <application>."
