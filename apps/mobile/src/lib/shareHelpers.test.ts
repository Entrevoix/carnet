import { describe, expect, it, vi } from "vitest";

// Stub the native module so the import chain in shareHelpers.ts doesn't try
// to load real expo-file-system off-device. Pure helpers (yamlQuote /
// sanitizeShareString) don't touch it; the readShareFileAsBase64 helper is
// covered by the integration path on device.
vi.mock("expo-file-system/legacy", () => ({
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  readAsStringAsync: vi.fn(),
  StorageAccessFramework: {
    readAsStringAsync: vi.fn(),
  },
}));

import {
  sanitizeShareString,
  yamlQuote,
  MAX_SAFE_SHARE_BYTES,
  BASE64_EXPANSION,
} from "./shareHelpers";

describe("sanitizeShareString", () => {
  it("replaces LF with space", () => {
    expect(sanitizeShareString("foo\nbar")).toBe("foo bar");
  });

  it("replaces CRLF with two spaces (one per char)", () => {
    expect(sanitizeShareString("foo\r\nbar")).toBe("foo  bar");
  });

  it("replaces CR alone with space", () => {
    expect(sanitizeShareString("foo\rbar")).toBe("foo bar");
  });

  it("leaves brackets, parens, quotes untouched", () => {
    expect(sanitizeShareString('hello [world] (parens) "q"')).toBe(
      'hello [world] (parens) "q"',
    );
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeShareString("")).toBe("");
  });

  it("leaves tabs untouched (tabs don't break our YAML/markdown structure)", () => {
    expect(sanitizeShareString("foo\tbar")).toBe("foo\tbar");
  });
});

describe("yamlQuote", () => {
  it("wraps a simple ASCII value in double quotes", () => {
    expect(yamlQuote("hello.mp3")).toBe('"hello.mp3"');
  });

  it("escapes embedded double quotes", () => {
    expect(yamlQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes embedded backslashes", () => {
    expect(yamlQuote("path\\to\\file")).toBe('"path\\\\to\\\\file"');
  });

  it("escapes backslash BEFORE quote so escape sequences round-trip safely", () => {
    // The naive order — escape quotes first, then backslashes — would
    // double-escape the backslash inserted by the quote-escape step.
    // Verify the inserted `\"` survives the backslash pass unchanged.
    expect(yamlQuote('a"b')).toBe('"a\\"b"');
  });

  it("strips LF inside the value (prevents YAML frontmatter injection)", () => {
    const evil = "evil\n---\nspoofed: true";
    const quoted = yamlQuote(evil);
    expect(quoted).toBe('"evil --- spoofed: true"');
    // The quoted value is still a single YAML line — no \n leaks out.
    expect(quoted.includes("\n")).toBe(false);
  });

  it("strips CR + LF in the same value", () => {
    expect(yamlQuote("a\r\nb")).toBe('"a  b"');
  });

  it("returns empty quotes for empty input", () => {
    expect(yamlQuote("")).toBe('""');
  });

  it("does not collapse spaces or trim — preserves visible whitespace", () => {
    expect(yamlQuote("  spaced  ")).toBe('"  spaced  "');
  });
});

describe("share-binary constants", () => {
  it("MAX_SAFE_SHARE_BYTES is 200 MB", () => {
    expect(MAX_SAFE_SHARE_BYTES).toBe(200 * 1024 * 1024);
  });

  it("BASE64_EXPANSION accounts for ~4/3 inflation plus header margin", () => {
    expect(BASE64_EXPANSION).toBeGreaterThan(4 / 3);
    expect(BASE64_EXPANSION).toBeLessThan(1.5);
  });
});
