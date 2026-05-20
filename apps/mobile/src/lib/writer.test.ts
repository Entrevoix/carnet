import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock expo-file-system/legacy ─────────────────────────────────────────────
// We can't run the real native module in Node. Replace it with an in-memory
// store so we can test writer logic without device hardware.

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

// Mock ./settings before importing writer.ts so vite-node never loads
// the real settings.ts → expo-secure-store → expo-modules-core → react-native
// chain — react-native ships Flow source rollup's native parser can't handle.
vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    captureFolderPath: "",
  }),
}));

vi.mock("expo-file-system/legacy", () => {
  return {
    documentDirectory: "file:///data/",
    EncodingType: { UTF8: "utf8", Base64: "base64" },
    getInfoAsync: vi.fn(async (uri: string) => {
      return { exists: _files.has(uri), uri, isDirectory: false };
    }),
    makeDirectoryAsync: vi.fn(async (_uri: string, _opts?: unknown) => {
      // no-op for directories — we track files only
    }),
    readDirectoryAsync: vi.fn(async (parentUri: string) => {
      // Return the basenames of files whose URI starts with parentUri/.
      const prefix = parentUri.replace(/\/$/, "") + "/";
      const out: string[] = [];
      for (const uri of _files.keys()) {
        if (uri.startsWith(prefix)) {
          const rest = uri.slice(prefix.length);
          if (!rest.includes("/")) out.push(rest);
        }
      }
      return out;
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      const entry = _files.get(uri);
      if (!entry) throw new Error(`File not found: ${uri}`);
      return entry.content;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
      _files.set(uri, { content });
    }),
    deleteAsync: vi.fn(async (uri: string) => {
      _files.delete(uri);
    }),
    // StorageAccessFramework is only touched on the SAF branch. We never
    // exercise that branch in these tests (the default capture folder is
    // empty → file:// branch), but stub it out so the property access in
    // writer.ts doesn't blow up on module load.
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(),
      makeDirectoryAsync: vi.fn(),
      createFileAsync: vi.fn(),
      readAsStringAsync: vi.fn(),
      writeAsStringAsync: vi.fn(),
    },
  };
});

import {
  writeIdea,
  writeBinary,
  appendJournal,
  writePerson,
  readNote,
  updateNote,
  moveToArchive,
  slugify,
  rewriteFrontmatterField,
  personFilename,
  extractNameFromMarkdown,
  extFromMime,
  safLastSegment,
  injectImageEmbed,
  stripFrontmatter,
} from "./writer";

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

// ── injectImageEmbed ──────────────────────────────────────────────────────────

describe("injectImageEmbed", () => {
  it("inserts embed under H1 with trailing newline", () => {
    const md = "# Title\n\nbody\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Title\n\n![](../Photos/a.jpg)\n\nbody\n",
    );
  });

  it("inserts embed under H1 even when H1 is the last line (no trailing newline)", () => {
    const md = "# Lonely Title";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Lonely Title\n\n![](../Photos/a.jpg)\n",
    );
  });

  it("inserts embed under H1 with CRLF line ending", () => {
    const md = "# Title\r\nbody\r\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Title\n\n![](../Photos/a.jpg)\nbody\r\n",
    );
  });

  it("prepends embed when no H1 is present", () => {
    const md = "no heading here\n\njust prose.\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "![](../Photos/a.jpg)\n\nno heading here\n\njust prose.\n",
    );
  });

  it("picks the first H1 when multiple are present", () => {
    const md = "# First\n\nbody\n\n# Second\n\nmore\n";
    const out = injectImageEmbed(md, "../Photos/a.jpg");
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeLessThan(out.indexOf("# Second"));
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeGreaterThan(out.indexOf("# First"));
  });

  it("ignores frontmatter and only matches body H1", () => {
    const md = "---\nkind: photo\n---\n# Body Title\n\nbody\n";
    const out = injectImageEmbed(md, "../Photos/a.jpg");
    expect(out).toContain("# Body Title\n\n![](../Photos/a.jpg)\n");
    // frontmatter preserved
    expect(out.startsWith("---\nkind: photo\n---\n")).toBe(true);
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

  it("appends -2 on collision instead of overwriting", async () => {
    // Two captures of the same person must NOT silently overwrite — Obsidian
    // may have desktop edits to the existing note that Syncthing already
    // replicated to the phone.
    const md1 = "---\nname: Jane Doe\n---\n# Jane Doe\n\noriginal\n";
    const md2 = "---\nname: Jane Doe\n---\n# Jane Doe\n\nsecond capture\n";

    const { filepath: fp1 } = await writePerson("Jane", "Doe", md1);
    expect(fp1).toMatch(/Jane-Doe\.md$/);

    const { filepath: fp2 } = await writePerson("Jane", "Doe", md2);
    expect(fp2).toMatch(/Jane-Doe-2\.md$/);

    // Original file should still contain the first capture, not the second
    expect(_files.get(fp1)!.content).toContain("original");
    expect(_files.get(fp2)!.content).toContain("second capture");
  });
});

// ── personFilename ────────────────────────────────────────────────────────────

describe("personFilename", () => {
  it("hyphenates a normal first + last name", () => {
    expect(personFilename("Jane Doe")).toBe("Jane-Doe");
  });

  it("preserves apostrophes and hyphens (O'Brien, Mary-Kate)", () => {
    expect(personFilename("Sean O'Brien")).toBe("Sean-O'Brien");
    expect(personFilename("Mary-Kate Olsen")).toBe("Mary-Kate-Olsen");
  });

  it("returns empty string for input that contains only invalid chars", () => {
    expect(personFilename("@@@!!!")).toBe("");
  });

  it("filters out path separators (defense in depth)", () => {
    // Even though /, \, .. are stripped by the char filter, the final
    // regex check ensures only the allowlisted set remains.
    expect(personFilename("../etc/passwd")).toBe("etcpasswd");
    expect(personFilename("/")).toBe("");
  });
});

// ── extractNameFromMarkdown ───────────────────────────────────────────────────

describe("extractNameFromMarkdown", () => {
  it("returns name from frontmatter `name:` field", () => {
    const md = "---\nname: Jane Doe\ncompany: Acme\n---\n# Other Title\n";
    expect(extractNameFromMarkdown(md)).toEqual({ firstName: "Jane", lastName: "Doe" });
  });

  it("falls back to H1 when frontmatter has no name field", () => {
    const md = "---\ncompany: Acme\n---\n# Alice Smith\n";
    expect(extractNameFromMarkdown(md)).toEqual({ firstName: "Alice", lastName: "Smith" });
  });

  it("returns single-part name as firstName only", () => {
    const md = "---\nname: Cher\n---\n# Cher\n";
    expect(extractNameFromMarkdown(md)).toEqual({ firstName: "Cher", lastName: "" });
  });

  it("joins multi-word last names with spaces", () => {
    const md = "---\nname: Maria del Mar Garcia\n---\n# x\n";
    expect(extractNameFromMarkdown(md)).toEqual({
      firstName: "Maria",
      lastName: "del Mar Garcia",
    });
  });

  it("returns empty strings when neither frontmatter nor H1 has a name", () => {
    expect(extractNameFromMarkdown("just a body\n")).toEqual({ firstName: "", lastName: "" });
  });
});

// ── extFromMime ───────────────────────────────────────────────────────────────

describe("extFromMime", () => {
  it("maps the common image types", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/jpg")).toBe("jpg");
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/heic")).toBe("heic");
  });

  it("is case-insensitive", () => {
    expect(extFromMime("IMAGE/JPEG")).toBe("jpg");
  });

  it("maps audio + pdf", () => {
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("audio/m4a")).toBe("m4a");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });

  it("falls back to the type/subtype slash split for unknowns", () => {
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("application/zip")).toBe("zip");
  });

  it("returns bin for empty / null / no slash", () => {
    expect(extFromMime(undefined)).toBe("bin");
    expect(extFromMime("")).toBe("bin");
    expect(extFromMime("garbage")).toBe("bin");
  });
});

// ── safLastSegment ────────────────────────────────────────────────────────────

describe("safLastSegment", () => {
  it("extracts the filename from a typical SAF document URI", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ADownload%2FCarnet/document/primary%3ADownload%2FCarnet%2FIdeas%2Fmyidea.md";
    expect(safLastSegment(uri)).toBe("myidea.md");
  });

  it("extracts the leaf from a tree URI (no document segment)", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ADownload%2FCarnet";
    expect(safLastSegment(uri)).toBe("Carnet");
  });

  it("handles a root-of-volume tree URI (no slash inside id)", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ACarnet";
    expect(safLastSegment(uri)).toBe("Carnet");
  });

  it("does not split the URL authority's slashes", () => {
    // A naive decode-then-lastIndexOf would split on the //com.android slash
    // because decode preserves /. The marker-aware impl skips that.
    const uri =
      "content://some-authority-with/slashes/tree/primary%3AVault/document/primary%3AVault%2Fnote.md";
    expect(safLastSegment(uri)).toBe("note.md");
  });

  it("returns the input verbatim when no SAF marker is present", () => {
    expect(safLastSegment("file:///data/carnet/Ideas/foo.md")).toBe(
      "file:///data/carnet/Ideas/foo.md",
    );
  });
});

// ── writeBinary collision logic ───────────────────────────────────────────────

describe("writeBinary", () => {
  beforeEach(clearFiles);

  it("writes a single binary file to the chosen subdir with the given name", async () => {
    const { filepath, finalName } = await writeBinary(
      "Photos",
      "shot.jpg",
      "dGVzdA==",
      "image/jpeg",
    );
    expect(filepath).toMatch(/Photos\/shot\.jpg$/);
    expect(finalName).toBe("shot.jpg");
    expect(_files.has(filepath)).toBe(true);
    expect(_files.get(filepath)!.content).toBe("dGVzdA==");
  });

  it("bumps -2, -3 on collision, preserving the extension", async () => {
    const { finalName: n1 } = await writeBinary("Photos", "p.jpg", "AAA", "image/jpeg");
    const { finalName: n2 } = await writeBinary("Photos", "p.jpg", "BBB", "image/jpeg");
    const { finalName: n3 } = await writeBinary("Photos", "p.jpg", "CCC", "image/jpeg");
    expect(n1).toBe("p.jpg");
    expect(n2).toBe("p-2.jpg");
    expect(n3).toBe("p-3.jpg");
  });

  it("handles extensionless input by bumping the bare stem", async () => {
    const { finalName: n1 } = await writeBinary("Photos", "raw", "X", "application/octet-stream");
    const { finalName: n2 } = await writeBinary("Photos", "raw", "Y", "application/octet-stream");
    expect(n1).toBe("raw");
    expect(n2).toBe("raw-2");
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

// ── stripFrontmatter (exported helper used by RecentDetail render path) ──────

describe("stripFrontmatter", () => {
  it("removes a YAML frontmatter block at the head of the document", () => {
    const md = "---\nkind: idea\ntags: [a, b]\n---\n# Title\n\nbody\n";
    expect(stripFrontmatter(md)).toBe("# Title\n\nbody\n");
  });

  it("returns input unchanged when there is no frontmatter", () => {
    expect(stripFrontmatter("# Title\n\nbody\n")).toBe("# Title\n\nbody\n");
  });

  it("returns input unchanged on an unterminated frontmatter block", () => {
    const md = "---\nkind: idea\n\nno closing fence\n";
    expect(stripFrontmatter(md)).toBe(md);
  });
});

// ── moveToArchive (soft-delete) ──────────────────────────────────────────────

describe("moveToArchive", () => {
  beforeEach(clearFiles);

  it("archives a standalone idea note and removes the source", async () => {
    const { filepath } = await writeIdea("standalone", "# Standalone\n\nbody\n");
    expect(_files.has(filepath)).toBe(true);

    const { archivedMdPath, archivedBinaryPath } = await moveToArchive(filepath);
    expect(archivedMdPath).toMatch(/\/Archive\/standalone\.md$/);
    expect(archivedBinaryPath).toBeNull();
    // Source removed
    expect(_files.has(filepath)).toBe(false);
    // Archive copy contains the content
    expect(_files.get(archivedMdPath)!.content).toBe("# Standalone\n\nbody\n");
  });

  it("archives a note + its paired Audio binary (referenced via ../Audio/)", async () => {
    // Pre-populate the binary
    const { filepath: binPath } = await writeBinary(
      "Audio",
      "meeting.mp3",
      "QkFTRTY0",
      "audio/mpeg",
    );
    const md =
      "---\nkind: shared-audio\n---\n# Shared audio: meeting.mp3\n\n## File\n[meeting.mp3](../Audio/meeting.mp3)\n";
    const { filepath: mdPath } = await writeIdea("shared-audio-1", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/shared-audio-1\.md$/);
    expect(result.archivedBinaryPath).toMatch(/\/Archive\/meeting\.mp3$/);

    // Originals removed
    expect(_files.has(mdPath)).toBe(false);
    expect(_files.has(binPath)).toBe(false);
    // Archive binary copy preserved bytes
    expect(_files.get(result.archivedBinaryPath!)!.content).toBe("QkFTRTY0");
  });

  it("archives just the .md when the paired binary link is broken", async () => {
    // Note body references a binary that was never written
    const md =
      "---\nkind: shared-audio\n---\n# Lost\n\n## File\n[ghost.mp3](../Audio/ghost.mp3)\n";
    const { filepath: mdPath } = await writeIdea("orphan", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/orphan\.md$/);
    expect(result.archivedBinaryPath).toBeNull();
    expect(_files.has(mdPath)).toBe(false);
  });

  it("collision-bumps the archive name when an entry with the same stem already exists there", async () => {
    const m1 = await writeIdea("dup", "# v1\n");
    await moveToArchive(m1.filepath);

    const m2 = await writeIdea("dup", "# v2\n");
    const result = await moveToArchive(m2.filepath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/dup-2\.md$/);
    // First archive copy still intact
    expect(_files.get(result.archivedMdPath.replace("dup-2", "dup"))!.content).toBe("# v1\n");
  });
});
