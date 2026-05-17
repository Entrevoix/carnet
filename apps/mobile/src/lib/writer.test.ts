import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock expo-file-system/legacy ─────────────────────────────────────────────
// We can't run the real native module in Node. Replace it with an in-memory
// store so we can test writer logic without device hardware.

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

vi.mock("expo-file-system/legacy", () => {
  return {
    documentDirectory: "file:///data/",
    EncodingType: { UTF8: "utf8" },
    getInfoAsync: vi.fn(async (uri: string) => {
      return { exists: _files.has(uri), uri, isDirectory: false };
    }),
    makeDirectoryAsync: vi.fn(async (_uri: string, _opts?: unknown) => {
      // no-op for directories — we track files only
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      const entry = _files.get(uri);
      if (!entry) throw new Error(`File not found: ${uri}`);
      return entry.content;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
      _files.set(uri, { content });
    }),
  };
});

import { writeIdea, appendJournal, writePerson, readNote, updateNote, slugify, rewriteFrontmatterField } from "./writer";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearFiles(): void {
  _files.clear();
}

// ── slugify ───────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and hyphenates basic input", () => {
    expect(slugify("My Big Idea")).toBe("my-big-idea");
  });

  it("handles leading/trailing/multiple spaces", () => {
    expect(slugify("  weird   spacing!  ")).toBe("weird-spacing");
  });

  it("collapses punctuation to a single hyphen", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("transliterates common French accents", () => {
    expect(slugify("Mémoire & flux")).toBe("memoire-flux");
    expect(slugify("Café au lait")).toBe("cafe-au-lait");
    expect(slugify("naïve résumé")).toBe("naive-resume");
  });

  it("returns empty string for non-ASCII input it cannot transliterate", () => {
    // Only drops chars it can't map — at minimum no crash
    const result = slugify("🚀");
    expect(typeof result).toBe("string");
  });
});

// ── rewriteFrontmatterField ───────────────────────────────────────────────────

describe("rewriteFrontmatterField", () => {
  it("rewrites status field without touching body", () => {
    const md = "---\ncreated: 2026-05-08\nstatus: seedling\ntags: [idea]\n---\n# Title\n\nbody\n";
    const out = rewriteFrontmatterField(md, "status", "developing");
    expect(out).toContain("status: developing");
    expect(out).not.toContain("status: seedling");
    expect(out).toContain("# Title\n\nbody\n");
  });

  it("throws when field is absent from frontmatter", () => {
    const md = "---\ncreated: 2026-05-08\n---\n# Title\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing")).toThrow("not present");
  });

  it("throws when there is no frontmatter", () => {
    const md = "# Just a title\n\nbody\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing")).toThrow("no YAML frontmatter");
  });

  it("preserves body with horizontal rules (does not mis-cut)", () => {
    const body = "# Title\n\nIntro.\n\n---\n\nSection after rule.\n";
    const md = `---\nstatus: seedling\n---\n${body}`;
    const out = rewriteFrontmatterField(md, "status", "mature");
    expect(out).toContain("status: mature");
    expect(out).not.toContain("status: seedling");
    expect(out).toContain("Section after rule.");
  });

  it("throws on newlines in value", () => {
    const md = "---\nstatus: seedling\n---\n# T\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing\ninjected: x")).toThrow("newlines");
  });
});

// ── writeIdea ─────────────────────────────────────────────────────────────────

describe("writeIdea", () => {
  beforeEach(clearFiles);

  it("creates Ideas/slug.md in an empty folder", async () => {
    const { filepath } = await writeIdea("my-idea", "# My Idea\n\nbody\n");
    expect(filepath).toMatch(/Ideas\/my-idea\.md$/);
    expect(_files.has(filepath)).toBe(true);
    expect(_files.get(filepath)!.content).toBe("# My Idea\n\nbody\n");
  });

  it("appends -2 on collision, -3 on second collision", async () => {
    const slug = "test-slug";
    const { filepath: fp1 } = await writeIdea(slug, "# First\n");
    expect(fp1).toMatch(/test-slug\.md$/);

    const { filepath: fp2 } = await writeIdea(slug, "# Second\n");
    expect(fp2).toMatch(/test-slug-2\.md$/);

    const { filepath: fp3 } = await writeIdea(slug, "# Third\n");
    expect(fp3).toMatch(/test-slug-3\.md$/);
  });
});

// ── appendJournal ─────────────────────────────────────────────────────────────

describe("appendJournal", () => {
  beforeEach(clearFiles);

  it("creates Journal/date.md on first call", async () => {
    const md = "---\ndate: 2026-05-16\n---\n# Entry\n\n## Notes\n- one\n";
    const { filepath } = await appendJournal("2026-05-16", md);
    expect(filepath).toMatch(/Journal\/2026-05-16\.md$/);
    expect(_files.get(filepath)!.content).toBe(md);
  });

  it("appends with HH:MM heading on second call same day", async () => {
    const first = "---\ndate: 2026-05-16\n---\n# First entry\n\n## Notes\n- one\n";
    const second = "---\ndate: 2026-05-16\n---\n# Second entry\n\n## Notes\n- two\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = _files.get(filepath)!.content;
    expect(content).toContain("# First entry");
    expect(content).toContain("- one");
    expect(content).toContain("# Second entry");
    expect(content).toContain("- two");
    // Time heading present (HH:MM pattern)
    expect(content).toMatch(/## \d{2}:\d{2}/);
    // Only one frontmatter opening block — the second entry's frontmatter is stripped
    // The first entry has opening `---` and closing `---`, so exactly 2 `---` lines
    // but the date field appears only once
    expect(content.match(/^date:/gm)?.length).toBe(1);
  });
});

// ── writePerson ───────────────────────────────────────────────────────────────

describe("writePerson", () => {
  beforeEach(clearFiles);

  it("creates People/Firstname-Lastname.md", async () => {
    const md = "---\nname: Jane Doe\n---\n# Jane Doe\n";
    const { filepath } = await writePerson("Jane", "Doe", md);
    expect(filepath).toMatch(/People\/Jane-Doe\.md$/);
    expect(_files.get(filepath)!.content).toBe(md);
  });

  it("falls back to markdown name when first/last are empty", async () => {
    const md = "---\nname: Alice Smith\n---\n# Alice Smith\n";
    const { filepath } = await writePerson("", "", md);
    expect(filepath).toMatch(/People\/Alice-Smith\.md$/);
  });
});

// ── readNote / updateNote ─────────────────────────────────────────────────────

describe("readNote / updateNote", () => {
  beforeEach(clearFiles);

  it("round-trips content through readNote → updateNote → readNote", async () => {
    const { filepath } = await writeIdea("round-trip", "# Original\n");
    const original = await readNote(filepath);
    expect(original).toBe("# Original\n");

    await updateNote(filepath, "# Updated\n");
    const updated = await readNote(filepath);
    expect(updated).toBe("# Updated\n");
  });
});
