import { describe, expect, it } from "vitest";

import {
  addTag,
  applyTagsToHeader,
  mergeUserTags,
  sameTagSet,
  splitTagInput,
  suggestionsFor,
} from "./tags";
import { getFrontmatterTags } from "./frontmatter";

// ── addTag ────────────────────────────────────────────────────────────────────

describe("addTag", () => {
  it("appends a normalized tag", () => {
    expect(addTag(["work"], "My Idea")).toEqual(["work", "my-idea"]);
  });

  it("returns the same reference (no-op) for a duplicate", () => {
    const tags = ["work"];
    expect(addTag(tags, "Work")).toBe(tags);
  });

  it("returns the same reference for a tag that normalizes to empty", () => {
    const tags = ["work"];
    expect(addTag(tags, "🚀")).toBe(tags);
    expect(addTag(tags, "###")).toBe(tags);
  });

  it("strips a leading hash and lowercases", () => {
    expect(addTag([], "#Urgent")).toEqual(["urgent"]);
  });
});

// ── suggestionsFor ────────────────────────────────────────────────────────────

describe("suggestionsFor", () => {
  const known = ["work", "workout", "homework", "idea", "journal"];

  it("returns most-used known tags for an empty query", () => {
    expect(suggestionsFor(known, "", [], 3)).toEqual(["work", "workout", "homework"]);
  });

  it("ranks prefix matches ahead of substring matches", () => {
    expect(suggestionsFor(known, "work", [])).toEqual(["work", "workout", "homework"]);
  });

  it("excludes already-chosen tags", () => {
    expect(suggestionsFor(known, "work", ["work"])).toEqual(["workout", "homework"]);
  });

  it("normalizes the query", () => {
    expect(suggestionsFor(known, "  WORK ", [])).toEqual(["work", "workout", "homework"]);
  });

  it("caps at the limit", () => {
    expect(suggestionsFor(known, "work", [], 1)).toEqual(["work"]);
  });

  it("returns [] when nothing matches", () => {
    expect(suggestionsFor(known, "zzz", [])).toEqual([]);
  });
});

// ── mergeUserTags ─────────────────────────────────────────────────────────────

describe("mergeUserTags", () => {
  it("is a no-op when there are no user tags", () => {
    const md = "---\ntags: [idea]\n---\n# T\n";
    expect(mergeUserTags(md, [])).toBe(md);
    expect(mergeUserTags(md, undefined)).toBe(md);
  });

  it("merges user tags with LLM-emitted tags, preserving both", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    const out = mergeUserTags(md, ["work"]);
    expect(getFrontmatterTags(out)).toEqual(["idea", "seedling", "work"]);
  });

  it("normalizes and de-duplicates against existing tags", () => {
    const md = "---\ntags: [idea]\n---\n# T\n";
    const out = mergeUserTags(md, ["Idea", "My Tag"]);
    expect(out).toContain("tags: [idea, my-tag]");
  });

  it("creates a tags field on a note that had none", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(mergeUserTags(md, ["work"])).toBe("---\nkind: idea\ntags: [work]\n---\n# T\n");
  });

  it("synthesizes a frontmatter block for an unfrontmattered note", () => {
    expect(mergeUserTags("# T\n\nbody\n", ["work"])).toBe(
      "---\ntags: [work]\n---\n# T\n\nbody\n",
    );
  });
});

// ── splitTagInput ─────────────────────────────────────────────────────────────

describe("splitTagInput", () => {
  it("commits nothing while typing a single token (no separator)", () => {
    expect(splitTagInput("wor")).toEqual({ committed: [], trailing: "wor" });
  });

  it("commits a token on a trailing space or comma", () => {
    expect(splitTagInput("work ")).toEqual({ committed: ["work"], trailing: "" });
    expect(splitTagInput("work,")).toEqual({ committed: ["work"], trailing: "" });
  });

  it("commits all complete tokens and keeps the trailing partial", () => {
    expect(splitTagInput("a, b, c")).toEqual({ committed: ["a", "b"], trailing: "c" });
  });

  it("splits a pasted multi-token string", () => {
    expect(splitTagInput("one two three")).toEqual({
      committed: ["one", "two"],
      trailing: "three",
    });
  });
});

// ── sameTagSet ────────────────────────────────────────────────────────────────

describe("sameTagSet", () => {
  it("is true for the same tags regardless of order", () => {
    expect(sameTagSet(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("is false on different length or membership", () => {
    expect(sameTagSet(["a"], ["a", "b"])).toBe(false);
    expect(sameTagSet(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("is true for two empty lists", () => {
    expect(sameTagSet([], [])).toBe(true);
  });
});

// ── applyTagsToHeader ─────────────────────────────────────────────────────────

describe("applyTagsToHeader", () => {
  it("returns the header byte-exact when the tag set is unchanged", () => {
    const header = "---\nkind: idea\ntags: [a, b]\n---\n";
    // Reordered edit list, same set → no rewrite (preserves original formatting).
    expect(applyTagsToHeader(header, ["b", "a"], ["a", "b"])).toBe(header);
  });

  it("does not add a tags field to a frontmatter-less note left untouched", () => {
    expect(applyTagsToHeader("", [], [])).toBe("");
  });

  it("rewrites the tags line when a tag is added", () => {
    const header = "---\nkind: idea\ntags: [a]\n---\n";
    expect(applyTagsToHeader(header, ["a", "b"], ["a"])).toBe(
      "---\nkind: idea\ntags: [a, b]\n---\n",
    );
  });

  it("inserts a tags field into a header that had none", () => {
    expect(applyTagsToHeader("---\nkind: idea\n---\n", ["work"], [])).toBe(
      "---\nkind: idea\ntags: [work]\n---\n",
    );
  });

  it("synthesizes a frontmatter block when adding tags to a header-less note", () => {
    expect(applyTagsToHeader("", ["work"], [])).toBe("---\ntags: [work]\n---\n");
  });

  it("writes an empty array when the user clears every tag", () => {
    expect(applyTagsToHeader("---\ntags: [a, b]\n---\n", [], ["a", "b"])).toBe(
      "---\ntags: []\n---\n",
    );
  });
});
