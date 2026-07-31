import { describe, expect, it } from "vitest";
import type { MD3Theme } from "react-native-paper";

import { markdownStyle } from "./markdownStyle";

// Distinct sentinel per color slot, so wiring any rule to the WRONG theme
// token (e.g. code_block.backgroundColor -> primary) changes the output.
const THEME = {
  colors: {
    onSurface: "#ON_SURFACE",
    surfaceVariant: "#SURFACE_VARIANT",
    onSurfaceVariant: "#ON_SURFACE_VARIANT",
    primary: "#PRIMARY",
  },
} as unknown as MD3Theme;

describe("markdownStyle", () => {
  it("pulls body + heading colors from onSurface and never sets a fontFamily", () => {
    const s = markdownStyle(THEME);
    for (const rule of [s.body, s.heading1, s.heading2, s.heading3]) {
      expect(rule.color).toBe("#ON_SURFACE");
      expect(rule).not.toHaveProperty("fontFamily");
    }
  });

  it("scales headings down h1 > h2 > h3, all above the body size", () => {
    const s = markdownStyle(THEME);
    expect(s.heading1.fontSize).toBeGreaterThan(s.heading2.fontSize);
    expect(s.heading2.fontSize).toBeGreaterThan(s.heading3.fontSize);
    expect(s.heading3.fontSize).toBeGreaterThan(s.body.fontSize);
    expect(s.heading1.fontWeight).toBe("700");
    expect(s.heading2.fontWeight).toBe("600");
  });

  it("gives code surfaces the surfaceVariant pair, not the body colors", () => {
    const s = markdownStyle(THEME);
    for (const rule of [s.code_inline, s.code_block, s.fence]) {
      expect(rule.backgroundColor).toBe("#SURFACE_VARIANT");
      expect(rule.color).toBe("#ON_SURFACE_VARIANT");
    }
    // Blocks get more breathing room than an inline span.
    expect(s.code_block.padding).toBeGreaterThan(s.code_inline.padding);
  });

  it("colors links with the primary accent", () => {
    expect(markdownStyle(THEME).link.color).toBe("#PRIMARY");
  });

  it("pins the exact numeric body metrics (DESIGN.md reading surface)", () => {
    const s = markdownStyle(THEME);
    expect(s.body.fontSize).toBe(15);
    expect(s.body.lineHeight).toBe(22);
    expect(s.bullet_list.marginTop).toBe(6);
    expect(s.ordered_list.marginTop).toBe(6);
  });
});
