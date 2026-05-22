#!/usr/bin/env bash
#
# Wrap `expo run:android` so the dev client always talks to Metro via
# localhost:8081 (over the adb USB reverse tunnel) instead of the dev
# machine's LAN IP. Eliminates the "Unable to load script" red screen
# that fires whenever the phone isn't on the same WiFi as the dev
# machine — which, for a USB-tethered dev workflow, is most of the time.
#
# What this does:
#   1. Locate adb (ANDROID_HOME → ANDROID_SDK_ROOT → PATH → default Linux
#      install). Skips gracefully with a warning if not found.
#   2. Re-establish `adb reverse tcp:8081 tcp:8081` so the device's
#      localhost:8081 maps to the host's Metro.
#   3. Export REACT_NATIVE_PACKAGER_HOSTNAME=localhost so Expo bakes
#      "localhost" into the deep-link URL it hands the dev client.
#   4. Exec expo run:android with any args forwarded.
#
# Why a script and not an inline `&&` in package.json: locating adb
# reliably across machines + handling the "device not connected yet"
# case + forwarding args is more than a JSON-shell-string can carry
# cleanly.

set -e

# ── locate adb ───────────────────────────────────────────────────────
if [ -n "${ANDROID_HOME:-}" ] && [ -x "${ANDROID_HOME}/platform-tools/adb" ]; then
  ADB="${ANDROID_HOME}/platform-tools/adb"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "${ANDROID_SDK_ROOT}/platform-tools/adb" ]; then
  ADB="${ANDROID_SDK_ROOT}/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
  ADB="$(command -v adb)"
elif [ -x "${HOME}/Android/Sdk/platform-tools/adb" ]; then
  ADB="${HOME}/Android/Sdk/platform-tools/adb"
elif [ -x "${HOME}/Library/Android/sdk/platform-tools/adb" ]; then
  # macOS default install location
  ADB="${HOME}/Library/Android/sdk/platform-tools/adb"
else
  ADB=""
fi

# ── wire localhost → Metro ───────────────────────────────────────────
if [ -n "$ADB" ]; then
  # Tolerates "no devices/emulators found" — expo run:android will
  # surface the device discovery error itself. The reverse only matters
  # once a device IS connected; running it pre-emptively is fine.
  "$ADB" reverse tcp:8081 tcp:8081 >/dev/null 2>&1 || true
else
  echo "WARN: adb not found in ANDROID_HOME, ANDROID_SDK_ROOT, PATH, or default Linux/macOS install paths." >&2
  echo "WARN: skipping adb reverse — if the phone is off-WiFi, expect the red screen." >&2
fi

# ── force localhost in the dev-client URL ────────────────────────────
# Without this, Expo discovers the dev machine's LAN IP and bakes it
# into the carnet://expo-development-client/?url=… deep link. The phone
# tries to reach that IP; fails if it's not on the same WiFi.
export REACT_NATIVE_PACKAGER_HOSTNAME=localhost

# ── launch ───────────────────────────────────────────────────────────
exec npx expo run:android "$@"
