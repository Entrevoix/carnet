#!/usr/bin/env bash
#
# Regression check for the withNetworkSecurityConfig config plugin
# (formerly withCleartextLocalProviders, #153/#154; extended for user-CA
# trust in #176).
#
# Runs a clean Android prebuild and asserts:
#   1. AndroidManifest.xml's <application> carries
#      android:networkSecurityConfig="@xml/network_security_config" (the
#      attribute that actually governs cleartext + trust-anchor behavior
#      once present — see the plugin's own comment on why
#      android:usesCleartextTraffic alone is no longer sufficient).
#   2. res/xml/network_security_config.xml was generated and contains
#      cleartextTrafficPermitted="true" on its base-config — Android IGNORES
#      android:usesCleartextTraffic entirely once networkSecurityConfig is
#      present, so losing this from the XML would silently regress plain
#      http:// to local providers (Relais at http://127.0.0.1:8080, LAN
#      Ollama) even though the inert manifest attribute is still set.
#   3. That XML's trust-anchors include BOTH src="system" and src="user" —
#      the latter is what makes a user-installed CA certificate (#176,
#      self-signed Relais over HTTPS) trusted app-wide.
#
# Cheaper than wiring vitest into plugins/ for these assertions — same
# rationale as the sibling verify-*-prebuild.sh scripts. (A small vitest
# suite ALSO exists at plugins/withNetworkSecurityConfig.test.js for the
# plugin's pure manifest/XML-generating functions — this script is the only
# thing that proves expo's actual prebuild wiring works end to end.)
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
NSC_XML="$ANDROID_DIR/app/src/main/res/xml/network_security_config.xml"

cd "$MOBILE_DIR"

echo "→ Cleaning android/ for a fresh prebuild…"
rm -rf "$ANDROID_DIR"

echo "→ Running expo prebuild (android only)…"
npx expo prebuild --platform android --no-install >/dev/null

echo "→ Asserting the manifest wires networkSecurityConfig…"
if [ ! -f "$MANIFEST" ]; then
  echo "✗ FAIL: $MANIFEST was not generated"
  exit 1
fi

if ! grep -q 'android:networkSecurityConfig="@xml/network_security_config"' "$MANIFEST"; then
  echo "✗ FAIL: android:networkSecurityConfig=\"@xml/network_security_config\" missing"
  echo "  from the manifest. Without it, Android falls back to its default"
  echo "  trust config — no cleartext to local providers (#153/#154), and no"
  echo "  trust for user-installed CA certs (#176)."
  exit 1
fi

# The attribute must be on <application>, not some nested element.
if ! tr -d '\n' < "$MANIFEST" | grep -q '<application[^>]*android:networkSecurityConfig="@xml/network_security_config"'; then
  echo "✗ FAIL: networkSecurityConfig present but not on <application>."
  exit 1
fi

echo "→ Asserting the network security config XML was generated…"
if [ ! -f "$NSC_XML" ]; then
  echo "✗ FAIL: $NSC_XML was not generated"
  exit 1
fi

echo "→ Asserting cleartextTrafficPermitted=\"true\" survives in the XML…"
if ! grep -q 'cleartextTrafficPermitted="true"' "$NSC_XML"; then
  echo "✗ FAIL: cleartextTrafficPermitted=\"true\" missing from"
  echo "  network_security_config.xml. Once networkSecurityConfig is set on"
  echo "  <application>, Android IGNORES android:usesCleartextTraffic"
  echo "  entirely — this XML attribute is now the ONLY thing permitting"
  echo "  plain http:// to local providers. See issue #153/#154."
  exit 1
fi

echo "→ Asserting both trust-anchors (system + user) are present…"
if ! grep -q '<certificates src="system"' "$NSC_XML"; then
  echo "✗ FAIL: <certificates src=\"system\" /> missing — normal https://"
  echo "  providers (public CAs) would stop being trusted."
  exit 1
fi

if ! grep -q '<certificates src="user"' "$NSC_XML"; then
  echo "✗ FAIL: <certificates src=\"user\" /> missing — a user-installed CA"
  echo "  certificate (issue #176, self-signed servers) would NOT be"
  echo "  trusted, even after the user installs it via Android Settings."
  exit 1
fi

echo "✓ withNetworkSecurityConfig verified: manifest wires the config, and"
echo "  the generated XML permits cleartext and trusts both system + user CAs."
