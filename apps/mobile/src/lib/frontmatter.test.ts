import { describe, expect, it } from "vitest";

import {
  parseFrontmatter,
  upsertFrontmatterField,
  getFrontmatterTags,
  setFrontmatterTags,
  normalizeTag,
  splitFrontmatter,
  extractFrontmatterField,
  rewriteFrontmatterField,
} from "./frontmatter";

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("returns ordered scalar fields with inline values", () => {
    const md = "---\nkind: idea\ncreated: 2026-05-08\nstatus: seedling\n---\n# T\n";
    expect(parseFrontmatter(md)).toEqual({
      hasBlock: true,
      fields: [
        ["kind", "idea"],
        ["created", "2026-05-08"],
        ["status", "seedling"],
      ],
    });
  });

  it("reports no block when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a title\n\nbody\n")).toEqual({
      hasBlock: false,
      fields: [],
    });
  });

  it("keeps the full inline value for a flow array", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([["tags", "[idea, seedling]"]]);
  });

  it("preserves a value containing a colon (greedy after the key)", () => {
    const md = "---\ntime: 10:30\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([["time", "10:30"]]);
  });

  it("ignores block-list continuation lines (use getFrontmatterTags for arrays)", () => {
    const md = "---\ntags:\n  - a\n  - b\nstatus: x\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([
      ["tags", ""],
      ["status", "x"],
    ]);
  });
});

// ── normalizeTag ──────────────────────────────────────────────────────────────

describe("normalizeTag", () => {
  it("lowercases, strips a leading hash, and hyphenates spaces", () => {
    expect(normalizeTag("#My Tag")).toBe("my-tag");
  });

  it("drops punctuation and other non [a-z0-9-] characters", () => {
    expect(normalizeTag("Hello, World!")).toBe("hello-world");
  });

  it("collapses repeat hyphens and trims edge hyphens", () => {
    expect(normalizeTag("  --my---tag--  ")).toBe("my-tag");
  });

  it("strips emoji and merges the surrounding text", () => {
    expect(normalizeTag("emoji🚀tag")).toBe("emojitag");
  });

  it("returns empty string for input that normalizes to nothing", () => {
    expect(normalizeTag("---")).toBe("");
    expect(normalizeTag("🚀")).toBe("");
    expect(normalizeTag("   ")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizeTag("#Work In Progress!");
    expect(once).toBe("work-in-progress");
    expect(normalizeTag(once)).toBe(once);
  });
});

// ── getFrontmatterTags ────────────────────────────────────────────────────────

describe("getFrontmatterTags", () => {
  it("reads an inline flow array", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["idea", "seedling"]);
  });

  it("reads a YAML block list", () => {
    const md = "---\nkind: idea\ntags:\n  - work\n  - urgent\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["work", "urgent"]);
  });

  it("reads a block list whose items sit at the key's own indent", () => {
    const md = "---\ntags:\n- a\n- b\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["a", "b"]);
  });

  it("returns [] for an empty flow array", () => {
    expect(getFrontmatterTags("---\ntags: []\n---\n# T\n")).toEqual([]);
  });

  it("returns [] when there is no tags field", () => {
    expect(getFrontmatterTags("---\nkind: idea\n---\n# T\n")).toEqual([]);
  });

  it("returns [] when there is no frontmatter", () => {
    expect(getFrontmatterTags("# T\n\nbody\n")).toEqual([]);
  });

  it("treats a bare scalar as a single tag", () => {
    expect(getFrontmatterTags("---\ntags: idea\n---\n# T\n")).toEqual(["idea"]);
  });

  it("strips surrounding quotes from flow items", () => {
    const md = "---\ntags: ['idea', \"work\"]\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["idea", "work"]);
  });

  it("stops the block scan at the next top-level key", () => {
    const md = "---\ntags:\n  - a\nstatus: developing\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["a"]);
  });
});

// ── upsertFrontmatterField ────────────────────────────────────────────────────

describe("upsertFrontmatterField", () => {
  it("rewrites an existing field, leaving others byte-exact", () => {
    const md = "---\nkind: idea\nlocation: 0,0\nstatus: seedling\n---\n# T\n\nbody\n";
    const out = upsertFrontmatterField(md, "location", "38.9072,-77.0369");
    expect(out).toBe(
      "---\nkind: idea\nlocation: 38.9072,-77.0369\nstatus: seedling\n---\n# T\n\nbody\n",
    );
  });

  it("inserts a missing field just before the closing fence", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(upsertFrontmatterField(md, "location", "1,2")).toBe(
      "---\nkind: idea\nlocation: 1,2\n---\n# T\n",
    );
  });

  it("synthesizes a frontmatter block when none exists", () => {
    expect(upsertFrontmatterField("# Just a title\n\nbody\n", "location", "1,2")).toBe(
      "---\nlocation: 1,2\n---\n# Just a title\n\nbody\n",
    );
  });

  it("preserves a body horizontal rule (does not mis-cut on `---`)", () => {
    const md = "---\nstatus: seedling\n---\n# T\n\nIntro.\n\n---\n\nAfter rule.\n";
    const out = upsertFrontmatterField(md, "status", "mature");
    expect(out).toContain("status: mature");
    expect(out).toContain("\n---\n\nAfter rule.\n");
  });

  it("preserves a frontmatter-only note with no trailing newline", () => {
    const md = "---\nkind: idea\n---";
    expect(upsertFrontmatterField(md, "location", "1,2")).toBe(
      "---\nkind: idea\nlocation: 1,2\n---",
    );
  });

  it("sweeps away the old block-list items when rewriting an array field inline", () => {
    const md = "---\ntags:\n  - old1\n  - old2\nstatus: x\n---\n# T\n";
    const out = upsertFrontmatterField(md, "tags", "[new]");
    expect(out).toBe("---\ntags: [new]\nstatus: x\n---\n# T\n");
  });

  it("rejects values containing newlines", () => {
    expect(() => upsertFrontmatterField("---\na: 1\n---\n", "a", "x\ninjected: y")).toThrow(
      "newlines",
    );
  });

  it("preserves the leading whitespace of an indented key on rewrite", () => {
    const md = "---\nmeta:\n  nested: old\n---\n# T\n";
    const out = upsertFrontmatterField(md, "nested", "new");
    expect(out).toContain("  nested: new");
  });
});

// ── setFrontmatterTags ────────────────────────────────────────────────────────

describe("setFrontmatterTags", () => {
  it("writes an inline flow array, upserting the field", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["work", "urgent"])).toBe(
      "---\nkind: idea\ntags: [work, urgent]\n---\n# T\n",
    );
  });

  it("normalizes and de-duplicates (case/whitespace folded once)", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["Idea", "idea", "My Tag", "my-tag"])).toBe(
      "---\nkind: idea\ntags: [idea, my-tag]\n---\n# T\n",
    );
  });

  it("merges with existing LLM tags when the caller composes them", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    const merged = [...getFrontmatterTags(md), "work"];
    expect(setFrontmatterTags(md, merged)).toBe(
      "---\ntags: [idea, seedling, work]\n---\n# T\n",
    );
  });

  it("replaces a block-list tags field with the inline form (no orphans)", () => {
    const md = "---\ntags:\n  - idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["idea", "work"])).toBe(
      "---\ntags: [idea, work]\n---\n# T\n",
    );
  });

  it("creates a frontmatter block for an unfrontmattered note", () => {
    expect(setFrontmatterTags("# T\n\nbody\n", ["a", "b"])).toBe(
      "---\ntags: [a, b]\n---\n# T\n\nbody\n",
    );
  });

  it("writes an empty array when every tag normalizes away", () => {
    expect(setFrontmatterTags("---\nkind: idea\n---\n# T\n", ["🚀", "---"])).toBe(
      "---\nkind: idea\ntags: []\n---\n# T\n",
    );
  });

  it("round-trips through getFrontmatterTags", () => {
    const md = setFrontmatterTags("---\nkind: idea\n---\n# T\n", ["Work", "in progress"]);
    expect(getFrontmatterTags(md)).toEqual(["work", "in-progress"]);
  });
});

// ── re-export parity (writer.ts still exposes the moved helpers) ──────────────

describe("re-exported helpers remain importable from ./frontmatter", () => {
  it("splitFrontmatter round-trips byte-for-byte", () => {
    const md = "---\nkind: idea\n---\n\n# T\n\nbody\n";
    const { header, body } = splitFrontmatter(md);
    expect(header + body).toBe(md);
  });

  it("extractFrontmatterField reads a scalar", () => {
    expect(extractFrontmatterField("---\nkind: photo\n---\n# T\n", "kind")).toBe("photo");
  });

  it("rewriteFrontmatterField still throws when the field is absent", () => {
    expect(() => rewriteFrontmatterField("---\nkind: idea\n---\n# T\n", "x", "y")).toThrow(
      "not present",
    );
  });
});
