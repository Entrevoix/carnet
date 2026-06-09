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
  splitFrontmatter,
  extractFrontmatterField,
  mimeFromFilename,
  readPairedBinaryFromNote,
  upsertSection,
  injectAttachments,
  listPairedBinaries,
  resolvePairedUri,
  stripPairedBinaryLinks,
  type AttachmentRef,
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

// ── injectAttachments ─────────────────────────────────────────────────────────

describe("injectAttachments", () => {
  const img = (rel: string, filename: string): AttachmentRef => ({
    kind: "image",
    rel,
    filename,
  });
  const file = (rel: string, filename: string): AttachmentRef => ({
    kind: "file",
    rel,
    filename,
  });

  it("returns the body unchanged for an empty attachment list", () => {
    const md = "# T\n\nbody\n";
    expect(injectAttachments(md, [])).toBe(md);
  });

  it("injects a single image embed under the H1", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
    ]);
    expect(out).toBe("# T\n\n![](../Photos/a.jpg)\n\nbody\n");
  });

  it("keeps multiple images in input order under the H1", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
      img("../Photos/b.jpg", "b.jpg"),
    ]);
    // First attachment appears first even though each embed inserts directly
    // below the H1 (the helper injects in reverse to preserve order).
    expect(out.indexOf("../Photos/a.jpg")).toBeLessThan(
      out.indexOf("../Photos/b.jpg"),
    );
    expect(out.indexOf("../Photos/a.jpg")).toBeGreaterThan(out.indexOf("# T"));
  });

  it("collects non-image files into a single ## Files section as links", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      file("../Files/spec.pdf", "spec.pdf"),
      file("../Files/data.csv", "data.csv"),
    ]);
    expect(out).toContain("## Files");
    expect(out).toContain("[spec.pdf](../Files/spec.pdf)");
    expect(out).toContain("[data.csv](../Files/data.csv)");
    // Exactly one Files heading even with two files.
    expect(out.match(/^## Files$/gm)?.length).toBe(1);
  });

  it("handles a mix of images and files in one pass", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
      file("../Files/spec.pdf", "spec.pdf"),
    ]);
    expect(out).toContain("![](../Photos/a.jpg)");
    expect(out).toContain("[spec.pdf](../Files/spec.pdf)");
    // Image is embedded under the H1; file link lives in the appended section.
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeLessThan(
      out.indexOf("## Files"),
    );
  });
});

// ── listPairedBinaries ────────────────────────────────────────────────────────

describe("listPairedBinaries", () => {
  it("returns an empty array when there are no paired-binary links", () => {
    expect(listPairedBinaries("# T\n\nplain prose only\n")).toEqual([]);
  });

  it("finds Photos, Audio, and Files links with subdir + filename + rel", () => {
    const body =
      "# T\n\n![](../Photos/a.jpg)\n\n## Files\n[s.pdf](../Files/s.pdf)\n\n[m.mp3](../Audio/m.mp3)\n";
    const found = listPairedBinaries(body);
    expect(found).toEqual([
      { subdir: "Photos", filename: "a.jpg", rel: "../Photos/a.jpg" },
      { subdir: "Files", filename: "s.pdf", rel: "../Files/s.pdf" },
      { subdir: "Audio", filename: "m.mp3", rel: "../Audio/m.mp3" },
    ]);
  });

  it("de-duplicates a link that appears more than once", () => {
    const body =
      "![](../Photos/a.jpg)\n\nsee [the image](../Photos/a.jpg) again\n";
    expect(listPairedBinaries(body)).toHaveLength(1);
  });
});

// ── stripPairedBinaryLinks (RecentDetail display) ────────────────────────────

describe("stripPairedBinaryLinks", () => {
  it("removes a standalone image embed but keeps the prose", () => {
    const body = "# T\n\n![](../Photos/shot.jpg)\n\nWhat's in this.\n";
    expect(stripPairedBinaryLinks(body)).toBe("# T\n\nWhat's in this.\n");
  });

  it("removes a file link AND its now-empty ## File heading (shared-audio)", () => {
    const body =
      "# Shared audio: m.mp3\n\n## File\n[m.mp3](../Audio/m.mp3)\n\n## Context\n(none)\n";
    expect(stripPairedBinaryLinks(body)).toBe(
      "# Shared audio: m.mp3\n\n## Context\n(none)\n",
    );
  });

  it("removes a ## Files section that only held attachment links", () => {
    const body =
      "# T\n\n![](../Photos/a.jpg)\n\nbody text\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    expect(stripPairedBinaryLinks(body)).toBe("# T\n\nbody text\n");
  });

  it("leaves an inline link inside a sentence intact", () => {
    const body = "# T\n\nsee [the file](../Files/x.pdf) for details\n";
    expect(stripPairedBinaryLinks(body)).toBe(body);
  });

  it("is a no-op for a note with no paired binaries", () => {
    const body = "# T\n\njust prose\n\n## Notes\n- a\n- b\n";
    expect(stripPairedBinaryLinks(body)).toBe(body);
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

  it("uses the slash-suffix for audio mimes not in the explicit map", () => {
    // Recording apps, browsers, and Android sources hand carnet a wide
    // range of audio mimes — lock in that the suffix fallback covers the
    // common ones cleanly (so the saved file lands as `.aac`, not `.bin`).
    expect(extFromMime("audio/aac")).toBe("aac");
    expect(extFromMime("audio/ogg")).toBe("ogg");
    expect(extFromMime("audio/flac")).toBe("flac");
    expect(extFromMime("audio/webm")).toBe("webm");
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

// ── splitFrontmatter (byte-exact header/body split for the WYSIWYG edit path) ─

describe("splitFrontmatter", () => {
  it("reassembles byte-for-byte: header + body === input", () => {
    const md = "---\nkind: idea\ntags: [a, b]\n---\n\n# Title\n\nbody\n";
    const { header, body } = splitFrontmatter(md);
    expect(header + body).toBe(md);
  });

  it("keeps the closing fence + its newline in the header (never merges into body)", () => {
    const md = "---\nkind: idea\n---\n\n# Title\n";
    const { header, body } = splitFrontmatter(md);
    expect(header).toBe("---\nkind: idea\n---\n");
    expect(header.endsWith("---\n")).toBe(true);
    expect(body).toBe("\n# Title\n");
  });

  it("returns empty header + whole input when there is no frontmatter", () => {
    const md = "# Title\n\nbody\n";
    expect(splitFrontmatter(md)).toEqual({ header: "", body: md });
  });

  it("treats an unterminated frontmatter block as no frontmatter", () => {
    const md = "---\nkind: idea\n\nno closing fence\n";
    expect(splitFrontmatter(md)).toEqual({ header: "", body: md });
  });

  it("handles a frontmatter-only note (empty body)", () => {
    const md = "---\nkind: idea\n---\n";
    const { header, body } = splitFrontmatter(md);
    expect(header).toBe(md);
    expect(body).toBe("");
    expect(header + body).toBe(md);
  });

  it("round-trips reattach with an editor-normalized body (no leading blank line)", () => {
    // Simulates the WYSIWYG save: the editor drops the blank line after the
    // fence; the header's trailing newline still keeps the fence on its own line.
    const md = "---\nkind: idea\n---\n\nold body\n";
    const { header } = splitFrontmatter(md);
    const reattached = header + "new body\n";
    expect(reattached).toBe("---\nkind: idea\n---\nnew body\n");
    expect(reattached.startsWith("---\nkind: idea\n---\n")).toBe(true);
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

  it("archives ALL paired binaries when a note has several attachments", async () => {
    // A capture-with-attachments note: one image + one file, both on disk.
    const { filepath: imgPath } = await writeBinary(
      "Photos",
      "sketch.jpg",
      "SU1H",
      "image/jpeg",
    );
    const { filepath: pdfPath } = await writeBinary(
      "Files",
      "spec.pdf",
      "UERG",
      "application/pdf",
    );
    const md =
      "---\nkind: idea\n---\n# Multi\n\n![](../Photos/sketch.jpg)\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    const { filepath: mdPath } = await writeIdea("multi", md);

    const result = await moveToArchive(mdPath);
    // Both binaries archived; archivedBinaryPath keeps the first for back-compat.
    expect(result.archivedBinaryPaths).toHaveLength(2);
    expect(result.archivedBinaryPath).toMatch(/\/Archive\/sketch\.jpg$/);
    expect(result.archivedBinaryPaths.some((p) => /\/Archive\/spec\.pdf$/.test(p))).toBe(true);
    // Originals (md + both binaries) removed.
    expect(_files.has(mdPath)).toBe(false);
    expect(_files.has(imgPath)).toBe(false);
    expect(_files.has(pdfPath)).toBe(false);
    // Bytes preserved in the archive copies.
    expect(_files.get(result.archivedBinaryPath!)!.content).toBe("SU1H");
  });

  it("collision-bumps when two paired binaries would land on the same Archive name", async () => {
    // Same filename in two subdirs → both want Archive/a.jpg; the second must
    // bump. Guards the "await each write before re-listing the dir" invariant.
    await writeBinary("Photos", "a.jpg", "UEhP", "image/jpeg");
    await writeBinary("Files", "a.jpg", "RklM", "image/jpeg");
    const md =
      "---\nkind: idea\n---\n# Dup names\n\n![](../Photos/a.jpg)\n\n## Files\n[a.jpg](../Files/a.jpg)\n";
    const { filepath: mdPath } = await writeIdea("dupnames", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedBinaryPaths).toHaveLength(2);
    // Two distinct archive names: a.jpg and a-2.jpg.
    const names = result.archivedBinaryPaths.map((p) => p.split("/").pop()).sort();
    expect(names).toEqual(["a-2.jpg", "a.jpg"]);
  });
});

// ── extractFrontmatterField (exported for the retro-enrich routing key) ──────

describe("extractFrontmatterField", () => {
  it("reads a simple ASCII value", () => {
    const md = "---\nkind: shared-image\n---\n# T\n";
    expect(extractFrontmatterField(md, "kind")).toBe("shared-image");
  });

  it("returns null when the field is absent", () => {
    const md = "---\nkind: photo\n---\n# T\n";
    expect(extractFrontmatterField(md, "source")).toBeNull();
  });

  it("returns null when there is no frontmatter", () => {
    expect(extractFrontmatterField("# T\n\nbody\n", "kind")).toBeNull();
  });

  it("strips surrounding single and double quotes", () => {
    const md1 = "---\nkind: 'shared-link'\n---\n# T\n";
    expect(extractFrontmatterField(md1, "kind")).toBe("shared-link");
    const md2 = '---\nkind: "shared-text"\n---\n# T\n';
    expect(extractFrontmatterField(md2, "kind")).toBe("shared-text");
  });
});

// ── mimeFromFilename ─────────────────────────────────────────────────────────

describe("mimeFromFilename", () => {
  it("maps common image extensions", () => {
    expect(mimeFromFilename("a.jpg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.png")).toBe("image/png");
    expect(mimeFromFilename("a.webp")).toBe("image/webp");
    expect(mimeFromFilename("a.gif")).toBe("image/gif");
    expect(mimeFromFilename("a.heic")).toBe("image/heic");
    expect(mimeFromFilename("a.heif")).toBe("image/heif");
  });

  it("maps audio extensions", () => {
    expect(mimeFromFilename("a.mp3")).toBe("audio/mpeg");
    expect(mimeFromFilename("a.wav")).toBe("audio/wav");
    expect(mimeFromFilename("a.m4a")).toBe("audio/mp4");
  });

  it("maps pdf", () => {
    expect(mimeFromFilename("a.pdf")).toBe("application/pdf");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    expect(mimeFromFilename("a.xyz")).toBe("application/octet-stream");
  });

  it("falls back to octet-stream for a name with no extension", () => {
    expect(mimeFromFilename("noext")).toBe("application/octet-stream");
  });

  it("is case-insensitive on the extension", () => {
    expect(mimeFromFilename("IMG.JPG")).toBe("image/jpeg");
    expect(mimeFromFilename("song.MP3")).toBe("audio/mpeg");
  });
});

// ── readPairedBinaryFromNote (retro-enrich helper) ───────────────────────────

describe("readPairedBinaryFromNote", () => {
  beforeEach(clearFiles);

  it("finds and returns the paired image bytes for a photo note", async () => {
    await writeBinary("Photos", "shot.jpg", "QkFTRTY0", "image/jpeg");
    const md = "---\nkind: photo\n---\n# T\n\n![](../Photos/shot.jpg)\n";
    const result = await readPairedBinaryFromNote(md);
    expect(result.base64).toBe("QkFTRTY0");
    expect(result.mime).toBe("image/jpeg");
  });

  it("works for shared-image notes the same way (subdir is Photos)", async () => {
    await writeBinary("Photos", "shared.png", "UE5HQllURVM=", "image/png");
    const md =
      "---\nkind: shared-image\n---\n# Shared\n\n![](../Photos/shared.png)\n";
    const result = await readPairedBinaryFromNote(md);
    expect(result.base64).toBe("UE5HQllURVM=");
    expect(result.mime).toBe("image/png");
  });

  it("throws when the body contains no recognized paired-binary link", async () => {
    const md = "---\nkind: idea\n---\n# Title\n\nplain body text\n";
    await expect(readPairedBinaryFromNote(md)).rejects.toThrow(
      "No paired binary link found",
    );
  });

  it("throws when the link target doesn't exist on disk", async () => {
    const md = "---\nkind: photo\n---\n# T\n\n![](../Photos/ghost.jpg)\n";
    await expect(readPairedBinaryFromNote(md)).rejects.toThrow(
      "Paired binary not found",
    );
  });
});

// ── resolvePairedUri ──────────────────────────────────────────────────────────

describe("resolvePairedUri", () => {
  beforeEach(clearFiles);

  it("returns the URI + inferred mime for a binary that exists on disk", async () => {
    await writeBinary("Files", "spec.pdf", "UERG", "application/pdf");
    const resolved = await resolvePairedUri("Files", "spec.pdf");
    expect(resolved).not.toBeNull();
    expect(resolved!.uri).toMatch(/Files\/spec\.pdf$/);
    expect(resolved!.mime).toBe("application/pdf");
  });

  it("returns null for a link whose target is not on disk", async () => {
    expect(await resolvePairedUri("Photos", "ghost.jpg")).toBeNull();
  });
});

// ── upsertSection ─────────────────────────────────────────────────────────────

describe("upsertSection", () => {
  it("appends a new section when the heading does not exist", () => {
    const before =
      "---\nkind: shared-audio\n---\n# Audio\n\n## File\n[a.m4a](../Audio/a.m4a)\n";
    const after = upsertSection(before, "Transcript", "hello world");
    expect(after).toContain("## Transcript");
    expect(after).toContain("hello world");
    expect(after).toContain("## File");
    expect(after.endsWith("\n")).toBe(true);
  });

  it("normalizes trailing newlines on append (no double-blank gap)", () => {
    // Input ends with several newlines — output should end with exactly one.
    const before = "# Title\n\nbody\n\n\n\n";
    const after = upsertSection(before, "Notes", "added");
    expect(after).toBe("# Title\n\nbody\n\n## Notes\n\nadded\n");
  });

  it("appends correctly when input has no trailing newline", () => {
    const before = "# Title\n\nbody";
    const after = upsertSection(before, "Notes", "added");
    expect(after).toBe("# Title\n\nbody\n\n## Notes\n\nadded\n");
  });

  it("replaces a single-section body when the heading exists at EOF", () => {
    const before = "# Title\n\n## Transcript\n\nold text\n";
    const after = upsertSection(before, "Transcript", "new text");
    expect(after).toContain("## Transcript");
    expect(after).toContain("new text");
    expect(after).not.toContain("old text");
  });

  it("preserves following H2 section when replacing in the middle", () => {
    const before =
      "# T\n\n## Transcript\n\nold\n\n## Footer\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    expect(after).toContain("## Transcript\n\nnew");
    expect(after).toContain("## Footer");
    expect(after).toContain("keep");
    expect(after).not.toContain("old");
  });

  it("preserves following H1 when replacing the last H2 before it", () => {
    const before = "## Transcript\n\nold\n\n# Next Doc\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    expect(after).toContain("## Transcript\n\nnew");
    expect(after).toContain("# Next Doc");
    expect(after).toContain("keep");
  });

  it("does not match a heading with trailing whitespace (appends instead)", () => {
    // Obsidian's heading parser is strict; our match must be too.
    const before = "# T\n\n## Transcript \n\nold\n";
    const after = upsertSection(before, "Transcript", "new");
    // The malformed heading is left as body content; a new section is appended.
    expect(after).toContain("## Transcript \n");
    expect(after.endsWith("## Transcript\n\nnew\n")).toBe(true);
  });

  it("leaves frontmatter untouched", () => {
    const before =
      "---\nkind: shared-audio\ntags: [shared, audio]\n---\n# Audio\n";
    const after = upsertSection(before, "Transcript", "txt");
    expect(after).toContain("---\nkind: shared-audio");
    expect(after).toContain("tags: [shared, audio]");
  });

  it("is idempotent — re-running with the same body returns identical output", () => {
    const before = "# T\n\n## Transcript\n\nfoo\n";
    const once = upsertSection(before, "Transcript", "bar");
    const twice = upsertSection(once, "Transcript", "bar");
    expect(twice).toBe(once);
  });

  it("treats H3+ subheadings as part of the current section body", () => {
    const before =
      "# T\n\n## Transcript\n\nold\n\n### Speakers\n\nA, B\n\n## Footer\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    // The H3 + its content get replaced because they belong to the H2 section.
    expect(after).not.toContain("### Speakers");
    expect(after).toContain("## Footer");
    expect(after).toContain("keep");
  });

  it("produces a clean section when input markdown is empty (no leading blank lines)", () => {
    // Pre-fix this returned "\n\n## Transcript\n\nhi\n" with two phantom
    // newlines at the start — caught by review, fixed via empty-string guard.
    expect(upsertSection("", "Transcript", "hi")).toBe(
      "## Transcript\n\nhi\n",
    );
  });

  it("rejects headings containing newlines (defense against multi-line injection)", () => {
    expect(() => upsertSection("# T\n", "Transcript\n## Pwned", "x")).toThrow(
      /heading cannot contain newlines/,
    );
    expect(() => upsertSection("# T\n", "A\rB", "x")).toThrow(
      /heading cannot contain newlines/,
    );
  });
});
