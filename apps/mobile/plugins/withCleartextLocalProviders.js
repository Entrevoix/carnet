// Sets android:usesCleartextTraffic="true" on <application>, making plain
// http:// behave the SAME on every Android version the app runs on.
//
// Why this exists (issue #153): with no explicit attribute, whether release
// builds may speak cleartext to 127.0.0.1 is platform-version-dependent —
// device-verified BOTH ways: a Pixel release build reached a loopback listener
// in plaintext (2026-08-01, and again via tarpit on 2026-08-16), while the
// same release APK on an API 35 emulator had every loopback fetch refused
// before a socket was even opened ("Network request failed", zero connections
// at a verified-listening tarpit). That nondeterminism broke the Relais preset
// (http://127.0.0.1:8080) on some devices and not others, and mislabeled the
// failures as "enrichment queued until OmniRoute is reachable".
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
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withCleartextLocalProviders(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error(
        'withCleartextLocalProviders: no <application> element in AndroidManifest',
      );
    }
    application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
