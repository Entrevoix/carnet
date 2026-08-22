// Emits an Android network security config and wires it onto <application>,
// so the app trusts (a) cleartext http:// to local providers and (b)
// certificates the user has deliberately installed into Android's user CA
// store (issue #176 — lets a self-signed Relais over HTTPS work once the
// user installs its cert via Android Settings).
//
// History: this file used to be withCleartextLocalProviders.js and only set
// android:usesCleartextTraffic="true" (issue #153/#154, see the block below
// for that rationale — device-verified: a Pixel release build reached a
// loopback listener in plaintext while the same APK on an API 35 emulator
// had every loopback fetch refused before a socket even opened). Renamed
// (git mv, history preserved) because its job outgrew a single manifest
// attribute once user-CA trust needed an actual network-security-config XML
// resource.
//
// ⚠️ CRITICAL: once android:networkSecurityConfig is present on <application>,
// Android IGNORES android:usesCleartextTraffic ENTIRELY — the XML's own
// <base-config cleartextTrafficPermitted="true"> is what governs cleartext
// now. Dropping that attribute from the XML (or losing the XML wiring) would
// silently regress cleartext-local (the #152/#154 bug class, which cost
// days) even though usesCleartextTraffic is still sitting harmlessly in the
// manifest. android:usesCleartextTraffic is kept below anyway as inert
// belt-and-braces (debug builds still read it before this config plugin's
// manifest mod runs in some tooling paths, and it costs nothing to leave).
// This is pinned three ways, not equally strong: a constant-level assertion
// (withNetworkSecurityConfig.test.js, runs in CI via vitest's plugins/**
// include) checks NETWORK_SECURITY_CONFIG_XML's literal content; a real
// `expo prebuild` + scripts/verify-cleartext-prebuild.sh checks the same
// thing survives actual generation — but that script is MANUAL-ONLY, it is
// not wired into ci.yml, so it only protects a contributor who remembers to
// run it locally before pushing.
//
// Why the platform gate opens fully instead of mirroring lib/netAllowlist.ts:
// Android's network-security-config matches DOMAINS (exact host or subdomain
// trees) — it cannot express the RFC1918 CIDR ranges (10/8, 172.16/12,
// 192.168/16) that netAllowlist.ts promises for LAN providers (Ollama,
// LM Studio). A loopback-only domain-config would keep that promise broken.
// The credential guard this app actually relies on is llmClient's
// isCredentialSafeUrl (exact-host parse, loopback+RFC1918 only) — the SAME
// arrangement every debug build has always run under, since Expo injects this
// exact attribute in debug. This plugin makes release match debug.
//
// Trust-posture honesty on <certificates src="user">: this is NOT merely
// matching Android's existing default. Since API 24, an app with no custom
// network security config trusts the SYSTEM CA store ONLY — a user-installed
// CA is excluded unless the app explicitly opts in, which is what this line
// does. Carnet is deliberately opting into the BROADER trust model a desktop
// browser uses (system + user CAs), a real posture change accepted for #176
// because a self-signed Relais is otherwise unusable over HTTPS and
// network-security-config can't scope trust per-domain when the server
// hostname is user-configured. The blast radius: any CA the user's device
// trusts (installed for Relais, or by anything else — an MDM profile, a
// tricked install) is now trusted for EVERY host Carnet talks to, including
// cloud providers' API endpoints. See docs/self-signed-certs.md, which
// carries the full tradeoff and the user-facing mitigation.
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

/** Pure manifest mutation, exported for unit testing without the full expo
 * config-plugins mod pipeline. Throws if <application> is missing, matching
 * the previous withCleartextLocalProviders behavior. */
function applyNetworkSecurityManifestAttrs(androidManifest) {
  const application = androidManifest.manifest.application?.[0];
  if (!application) {
    throw new Error(
      'withNetworkSecurityConfig: no <application> element in AndroidManifest',
    );
  }
  application.$['android:usesCleartextTraffic'] = 'true';
  application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
  return androidManifest;
}

module.exports = function withNetworkSecurityConfig(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyNetworkSecurityManifestAttrs(cfg.modResults);
    return cfg;
  });

  // Emit the XML resource itself — withAndroidManifest alone only edits the
  // manifest, it can't create a new res/xml/ file.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG_XML,
        'utf8',
      );
      return cfg;
    },
  ]);

  return config;
};

module.exports.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
module.exports.applyNetworkSecurityManifestAttrs = applyNetworkSecurityManifestAttrs;
