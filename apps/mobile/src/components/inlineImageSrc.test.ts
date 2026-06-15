/**
 * Unit tests for classifyImageSrc — the decision logic behind the inline
 * markdown image rule. The JSX wrapper (makeImageRule) is a thin shell over
 * this; the routing of a src to local / external / hidden is what matters.
 */

import { describe, expect, it } from "vitest";

import { classifyImageSrc } from "./inlineImageSrc";

describe("classifyImageSrc", () => {
  const map = new Map<string, string>([
    ["../Photos/shot.jpg", "file:///vault/Photos/shot.jpg"],
    ["../Photos/saf.png", "content://com.android.providers/Photos/saf.png"],
  ]);

  it("resolves a known paired Photos embed to its device URI", () => {
    expect(classifyImageSrc("../Photos/shot.jpg", map)).toEqual({
      kind: "local",
      uri: "file:///vault/Photos/shot.jpg",
    });
  });

  it("resolves a SAF content:// paired embed", () => {
    expect(classifyImageSrc("../Photos/saf.png", map)).toEqual({
      kind: "local",
      uri: "content://com.android.providers/Photos/saf.png",
    });
  });

  it("passes an external https image through as-is", () => {
    expect(classifyImageSrc("https://example.com/a.png", map)).toEqual({
      kind: "external",
      uri: "https://example.com/a.png",
    });
  });

  it("passes a data: URI through as-is", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(classifyImageSrc(src, map)).toEqual({ kind: "external", uri: src });
  });

  it("hides an unresolved paired embed (broken link — file moved/renamed)", () => {
    expect(classifyImageSrc("../Photos/missing.jpg", map)).toEqual({
      kind: "hidden",
    });
  });

  it("hides a stray relative path the renderer couldn't load", () => {
    expect(classifyImageSrc("./local/x.png", map)).toEqual({ kind: "hidden" });
  });

  it("resolves a percent-encoded src against a raw (non-ASCII) rel key", () => {
    // markdown-it normalizeLink encodes the src; the map key stays raw.
    const m = new Map([["../Photos/café.jpg", "file:///vault/Photos/café.jpg"]]);
    expect(classifyImageSrc("../Photos/caf%C3%A9.jpg", m)).toEqual({
      kind: "local",
      uri: "file:///vault/Photos/café.jpg",
    });
  });

  it("does not throw on a malformed percent-encoding, just hides it", () => {
    expect(classifyImageSrc("../Photos/%E0%A4%A.jpg", map)).toEqual({
      kind: "hidden",
    });
  });

  it("trims surrounding whitespace before matching the rel", () => {
    expect(classifyImageSrc("  ../Photos/shot.jpg  ", map)).toEqual({
      kind: "local",
      uri: "file:///vault/Photos/shot.jpg",
    });
  });

  it("hides an empty src", () => {
    expect(classifyImageSrc("", map)).toEqual({ kind: "hidden" });
  });
});
