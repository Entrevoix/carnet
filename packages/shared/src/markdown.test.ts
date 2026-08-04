import { describe, expect, it } from "vitest";

import { IDEA_STATUSES, deriveTitle, parseStatusFromMarkdown } from "./markdown";

describe("parseStatusFromMarkdown", () => {
  it("reads a bare status value", () => {
    expect(parseStatusFromMarkdown("---\nstatus: seedling\n---\n")).toBe("seedling");
  });

  it("tolerates double and single quotes the model sometimes adds", () => {
    expect(parseStatusFromMarkdown('status: "developing"')).toBe("developing");
    expect(parseStatusFromMarkdown("status: 'mature'")).toBe("mature");
  });

  it("matches the field on its own line, not mid-sentence", () => {
    // Anchored per-line, so prose mentioning the word must not win.
    expect(parseStatusFromMarkdown("The status: seedling is a lie\nstatus: mature")).toBe("mature");
  });

  it("rejects a value outside the known set", () => {
    expect(parseStatusFromMarkdown("status: compost")).toBeNull();
  });

  it("returns null when there is no status field", () => {
    expect(parseStatusFromMarkdown("# Just a note\n\nNo frontmatter here.")).toBeNull();
  });

  it("accepts every status the constant advertises", () => {
    for (const status of IDEA_STATUSES) {
      expect(parseStatusFromMarkdown(`status: ${status}`)).toBe(status);
    }
  });
});

describe("deriveTitle", () => {
  it("prefers the first H1", () => {
    expect(deriveTitle("---\nstatus: seedling\n---\n\n# Real Title\n\nBody")).toBe("Real Title");
  });

  it("takes the first H1 even when indented", () => {
    expect(deriveTitle("   # Indented Title\nbody")).toBe("Indented Title");
  });

  it("ignores deeper headings", () => {
    expect(deriveTitle("## Not H1\n# Actual H1")).toBe("Actual H1");
  });

  it("falls back to the first line when there is no H1", () => {
    expect(deriveTitle("A plain first line\nmore")).toBe("A plain first line");
  });

  it("truncates a long fallback line to 60 characters", () => {
    expect(deriveTitle("x".repeat(100))).toHaveLength(60);
  });

  it("returns an empty string when there is no derivable title", () => {
    // Load-bearing, NOT a gap. Callers chain their own fallback off the falsy
    // value (`|| stem`, `|| "Idea"`); returning a placeholder here would steal
    // it and every untitled note would read "Untitled" instead of its filename.
    expect(deriveTitle("")).toBe("");
    expect(deriveTitle("\n\nbody after a blank first line")).toBe("");
  });
});
