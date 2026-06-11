import { describe, expect, it } from "vitest";

import { addTag, mergeUserTags, suggestionsFor } from "./tags";
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
