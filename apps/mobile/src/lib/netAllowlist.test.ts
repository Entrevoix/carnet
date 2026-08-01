import { describe, expect, it } from "vitest";

import { isAllowedPlaintextHost, isCredentialSafeUrl } from "./netAllowlist";

// M3 — HTTPS enforcement regex-bypass fix. The old right-unanchored prefix
// regex (/^http:\/\/(localhost|127\.0\.0\.1|10\.)/) matched attacker hosts
// that merely START with an allowed token. isCredentialSafeUrl parses the
// exact hostname via new URL() and closes that hole.
describe("isCredentialSafeUrl", () => {
  it("rejects http://10.evil.com (not a valid 10.x address)", () => {
    expect(isCredentialSafeUrl("http://10.evil.com")).toBe(false);
  });

  it("rejects http://localhost.attacker.com", () => {
    expect(isCredentialSafeUrl("http://localhost.attacker.com")).toBe(false);
  });

  it("rejects http://127.0.0.1.attacker.com", () => {
    expect(isCredentialSafeUrl("http://127.0.0.1.attacker.com")).toBe(false);
  });

  it("allows http://10.0.0.1 (genuine 10.x LAN)", () => {
    expect(isCredentialSafeUrl("http://10.0.0.1")).toBe(true);
  });

  it("allows http://localhost", () => {
    expect(isCredentialSafeUrl("http://localhost")).toBe(true);
    expect(isCredentialSafeUrl("http://localhost:8080/v1")).toBe(true);
  });

  it("allows http://127.0.0.1", () => {
    expect(isCredentialSafeUrl("http://127.0.0.1")).toBe(true);
  });

  it("allows http://192.168.1.20 (LAN OmniRoute)", () => {
    expect(isCredentialSafeUrl("http://192.168.1.20")).toBe(true);
  });

  it("allows https://example.com (HTTPS always allowed)", () => {
    expect(isCredentialSafeUrl("https://example.com")).toBe(true);
  });

  it("rejects other schemes and unparseable input", () => {
    expect(isCredentialSafeUrl("ftp://10.0.0.1")).toBe(false);
    expect(isCredentialSafeUrl("not-a-url")).toBe(false);
    expect(isCredentialSafeUrl("")).toBe(false);
  });
});

describe("isAllowedPlaintextHost", () => {
  it("matches loopback and RFC1918 hosts by exact hostname", () => {
    expect(isAllowedPlaintextHost("http://localhost")).toBe(true);
    expect(isAllowedPlaintextHost("http://127.0.0.1")).toBe(true);
    expect(isAllowedPlaintextHost("http://10.0.0.1")).toBe(true);
    expect(isAllowedPlaintextHost("http://192.168.1.20")).toBe(true);
  });

  it("does not match hosts that merely start with an allowed token", () => {
    expect(isAllowedPlaintextHost("http://10.evil.com")).toBe(false);
    expect(isAllowedPlaintextHost("http://localhost.attacker.com")).toBe(false);
    expect(isAllowedPlaintextHost("http://127.0.0.1.attacker.com")).toBe(false);
    // 192.168 as a subdomain label, not an address.
    expect(isAllowedPlaintextHost("http://192.168.evil.com")).toBe(false);
  });
});

// 172.16/12 is as much RFC1918 as 10/8 and 192.168/16, but was omitted — a
// Relais on 172.20.x.x was refused by our own guard before any request was
// made. The bounds are load-bearing: 172.15.x and 172.32.x are PUBLIC space,
// so a sloppy `parts[0] === "172"` check would allow plaintext to the internet.
describe("172.16/12 (RFC1918)", () => {
  it("allows the whole 172.16-31 range", () => {
    expect(isAllowedPlaintextHost("http://172.16.0.1:8080")).toBe(true);
    expect(isAllowedPlaintextHost("http://172.20.10.5:8080")).toBe(true);
    expect(isAllowedPlaintextHost("http://172.31.255.254:8080")).toBe(true);
  });

  it("rejects the addresses just outside it", () => {
    expect(isAllowedPlaintextHost("http://172.15.0.1:8080")).toBe(false);
    expect(isAllowedPlaintextHost("http://172.32.0.1:8080")).toBe(false);
    expect(isAllowedPlaintextHost("http://172.0.0.1:8080")).toBe(false);
    expect(isAllowedPlaintextHost("http://172.255.0.1:8080")).toBe(false);
  });

  it("carries through isCredentialSafeUrl", () => {
    expect(isCredentialSafeUrl("http://172.20.0.1:8080")).toBe(true);
    expect(isCredentialSafeUrl("http://172.32.0.1:8080")).toBe(false);
  });
});
