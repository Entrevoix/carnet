import { describe, expect, it } from "vitest";

import {
  wrapSelection,
  prefixLines,
  insertAtCursor,
  applyFormat,
  type Sel,
} from "./markdownEdit";

const sel = (start: number, end: number): Sel => ({ start, end });

// ── wrapSelection ─────────────────────────────────────────────────────────────

describe("wrapSelection", () => {
  it("wraps a selection and keeps the original content selected", () => {
    const r = wrapSelection("hello world", sel(0, 5), "**");
    expect(r.text).toBe("**hello** world");
    expect(r.selection).toEqual(sel(2, 7));
  });

  it("toggles off when the markers sit just outside the selection", () => {
    // The selection from the wrap above, re-applied, unwraps.
    const r = wrapSelection("**hello** world", sel(2, 7), "**");
    expect(r.text).toBe("hello world");
    expect(r.selection).toEqual(sel(0, 5));
  });

  it("strips markers captured inside the selection (**x** selected)", () => {
    const r = wrapSelection("**hello**", sel(0, 9), "**");
    expect(r.text).toBe("hello");
    expect(r.selection).toEqual(sel(0, 5));
  });

  it("inserts an empty pair with the cursor between for an empty selection", () => {
    const r = wrapSelection("", sel(0, 0), "*");
    expect(r.text).toBe("**");
    expect(r.selection).toEqual(sel(1, 1));
  });

  it("collapses an empty pair when the cursor sits between it", () => {
    const r = wrapSelection("****", sel(2, 2), "**");
    expect(r.text).toBe("");
    expect(r.selection).toEqual(sel(0, 0));
  });

  it("wraps at end-of-string without index underflow", () => {
    const r = wrapSelection("ab", sel(2, 2), "`");
    expect(r.text).toBe("ab``");
    expect(r.selection).toEqual(sel(3, 3));
  });

  it("wraps inline code with backticks", () => {
    const r = wrapSelection("let x", sel(4, 5), "`");
    expect(r.text).toBe("let `x`");
  });

  it("does NOT delete bare markers when a different marker is applied", () => {
    // Regression: selecting just `**` and applying italic `*` must not be read
    // as an empty wrapped pair and deleted — it wraps the literal characters.
    const r = wrapSelection("a**b", sel(1, 3), "*");
    expect(r.text).toBe("a****b");
    expect(r.text).not.toBe("ab");
  });
});

// ── prefixLines ───────────────────────────────────────────────────────────────

describe("prefixLines", () => {
  it("prefixes every selected line with a bullet", () => {
    const r = prefixLines("a\nb\nc", sel(0, 5), "- ");
    expect(r.text).toBe("- a\n- b\n- c");
    expect(r.selection).toEqual(sel(0, 11));
  });

  it("numbers selected lines for an ordered list", () => {
    const r = prefixLines("a\nb\nc", sel(0, 5), "1. ");
    expect(r.text).toBe("1. a\n2. b\n3. c");
  });

  it("toggles a bullet list off when every line already has it", () => {
    const r = prefixLines("- a\n- b", sel(0, 7), "- ");
    expect(r.text).toBe("a\nb");
  });

  it("adds a checkbox prefix", () => {
    const r = prefixLines("task", sel(0, 0), "- [ ] ");
    expect(r.text).toBe("- [ ] task");
  });

  it("adds a heading prefix to a plain line", () => {
    const r = prefixLines("foo", sel(0, 0), "## ");
    expect(r.text).toBe("## foo");
  });

  it("replaces an existing heading level instead of stacking", () => {
    const r = prefixLines("## foo", sel(0, 0), "# ");
    expect(r.text).toBe("# foo");
  });

  it("toggles a heading off when the same level is re-applied", () => {
    const r = prefixLines("## foo", sel(0, 0), "## ");
    expect(r.text).toBe("foo");
  });

  it("only prefixes the lines the selection actually overlaps", () => {
    // Selection sits entirely on the middle line.
    const r = prefixLines("first\nsecond\nthird", sel(6, 10), "- ");
    expect(r.text).toBe("first\n- second\nthird");
  });

  it("skips blank lines when prefixing", () => {
    const r = prefixLines("a\n\nb", sel(0, 4), "- ");
    expect(r.text).toBe("- a\n\n- b");
  });

  it("does NOT prefix the next line when the selection ends at a line boundary", () => {
    // Regression: dragging a full line selects through its trailing newline, so
    // the selection ends at col 0 of the next line — which must stay untouched.
    const r = prefixLines("first\nsecond", sel(0, 6), "- ");
    expect(r.text).toBe("- first\nsecond");
  });
});

// ── insertAtCursor ────────────────────────────────────────────────────────────

describe("insertAtCursor", () => {
  it("inserts a snippet at the cursor and lands after it by default", () => {
    const r = insertAtCursor("ab", sel(1, 1), "X");
    expect(r.text).toBe("aXb");
    expect(r.selection).toEqual(sel(2, 2));
  });

  it("replaces a selection with the snippet", () => {
    const r = insertAtCursor("a BAD b", sel(2, 5), "good");
    expect(r.text).toBe("a good b");
  });

  it("positions a collapsed cursor at a numeric offset", () => {
    const r = insertAtCursor("ab", sel(1, 1), "XYZ", 1);
    expect(r.selection).toEqual(sel(2, 2));
  });

  it("selects a range within the inserted snippet", () => {
    const r = insertAtCursor("ab", sel(1, 1), "XYZ", { start: 1, end: 3 });
    expect(r.selection).toEqual(sel(2, 4));
  });
});

// ── applyFormat (intent → transform mapping) ──────────────────────────────────

describe("applyFormat", () => {
  it("maps bold to a ** wrap", () => {
    expect(applyFormat("hi", sel(0, 2), "bold").text).toBe("**hi**");
  });

  it("builds a link from the selected text and selects the url placeholder", () => {
    const r = applyFormat("see cd here", sel(4, 6), "link");
    expect(r.text).toBe("see [cd](url) here");
    // The "url" placeholder is selected for immediate overtype.
    expect(r.text.slice(r.selection.start, r.selection.end)).toBe("url");
  });

  it("builds a link with placeholder text when nothing is selected", () => {
    const r = applyFormat("", sel(0, 0), "link");
    expect(r.text).toBe("[text](url)");
    expect(r.text.slice(r.selection.start, r.selection.end)).toBe("url");
  });

  it("maps checkbox to a task-list prefix", () => {
    expect(applyFormat("buy milk", sel(0, 0), "checkbox").text).toBe(
      "- [ ] buy milk",
    );
  });
});
