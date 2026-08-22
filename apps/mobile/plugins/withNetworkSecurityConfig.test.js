// Unit tests for withNetworkSecurityConfig's pure functions — the manifest
// mutation and the generated XML content. The actual expo mod pipeline
// (withDangerousMod writing the file into android/, withAndroidManifest's
// serialize/parse round-trip) is exercised by a real prebuild instead, in
// scripts/verify-cleartext-prebuild.sh — that's the only thing that proves
// expo's wiring works end to end, since these unit tests never touch
// android/.
import { describe, expect, it } from "vitest";
import {
  NETWORK_SECURITY_CONFIG_XML,
  applyNetworkSecurityManifestAttrs,
} from "./withNetworkSecurityConfig.js";

function fakeManifest(withApplication = true) {
  return {
    manifest: {
      application: withApplication ? [{ $: {} }] : [],
    },
  };
}

describe("applyNetworkSecurityManifestAttrs", () => {
  it("sets both usesCleartextTraffic and networkSecurityConfig on <application>", () => {
    const result = applyNetworkSecurityManifestAttrs(fakeManifest());
    const application = result.manifest.application[0];
    expect(application.$["android:usesCleartextTraffic"]).toBe("true");
    expect(application.$["android:networkSecurityConfig"]).toBe(
      "@xml/network_security_config",
    );
  });

  it("throws when there is no <application> element", () => {
    expect(() => applyNetworkSecurityManifestAttrs(fakeManifest(false))).toThrow(
      /no <application> element/,
    );
  });

  it("does not clobber pre-existing attributes on <application>", () => {
    const manifest = fakeManifest();
    manifest.manifest.application[0].$["android:label"] = "Carnet";
    const result = applyNetworkSecurityManifestAttrs(manifest);
    expect(result.manifest.application[0].$["android:label"]).toBe("Carnet");
  });
});

describe("NETWORK_SECURITY_CONFIG_XML", () => {
  // The critical regression this pins: once networkSecurityConfig is set on
  // <application>, Android ignores android:usesCleartextTraffic entirely —
  // cleartextTrafficPermitted="true" in THIS xml is the only thing left
  // permitting plain http:// to local providers (#153/#154). A change that
  // drops this attribute (or moves it off base-config) must fail here.
  it("permits cleartext traffic on the base-config", () => {
    expect(NETWORK_SECURITY_CONFIG_XML).toMatch(
      /<base-config cleartextTrafficPermitted="true">/,
    );
  });

  it("trusts the system CA store", () => {
    expect(NETWORK_SECURITY_CONFIG_XML).toMatch(
      /<certificates src="system"\s*\/>/,
    );
  });

  // #176: trusting user-installed certs is what makes a self-signed server
  // work after the user installs its cert via Android Settings. Losing this
  // line would silently break that feature while everything else compiles.
  it("trusts the user CA store", () => {
    expect(NETWORK_SECURITY_CONFIG_XML).toMatch(
      /<certificates src="user"\s*\/>/,
    );
  });

  it("is well-formed enough to round-trip through a naive XML parity check", () => {
    const opens = (NETWORK_SECURITY_CONFIG_XML.match(/<[a-zA-Z-]+[ >]/g) ?? [])
      .length;
    const closes = (NETWORK_SECURITY_CONFIG_XML.match(/<\/[a-zA-Z-]+>/g) ?? [])
      .length;
    const selfClosing = (
      NETWORK_SECURITY_CONFIG_XML.match(/\/>/g) ?? []
    ).length;
    expect(opens).toBe(closes + selfClosing);
  });
});

// Negative control: prove the assertion above actually catches a regression,
// rather than trivially passing on anything. If someone "fixes" this test
// by weakening the regex instead of the plugin, this case still fails.
describe("negative control", () => {
  it("would fail the cleartext assertion if cleartextTrafficPermitted were removed", () => {
    const regressed = NETWORK_SECURITY_CONFIG_XML.replace(
      ' cleartextTrafficPermitted="true"',
      "",
    );
    expect(regressed).not.toMatch(/cleartextTrafficPermitted="true"/);
  });

  it("would fail the user-trust-anchor assertion if src=\"user\" were removed", () => {
    const regressed = NETWORK_SECURITY_CONFIG_XML.replace(
      /\s*<certificates src="user"\s*\/>\n?/,
      "",
    );
    expect(regressed).not.toMatch(/<certificates src="user"/);
  });
});
