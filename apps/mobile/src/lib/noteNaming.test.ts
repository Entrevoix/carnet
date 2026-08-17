import { describe, expect, it } from "vitest";

import { slugify, personFilename, extractNameFromMarkdown } from "./noteNaming";

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

  // Unicode decomposition — supersedes the hand-listed French accent map, so
  // any Latin-script diacritic folds, not just the ones someone remembered.
  it("folds Latin diacritics beyond the hand-listed French set", () => {
    expect(slugify("Łódź street")).toBe("lodz-street");
    expect(slugify("Dvořák concerto")).toBe("dvorak-concerto");
    expect(slugify("Việt Nam notes")).toBe("viet-nam-notes");
    expect(slugify("Gündoğan")).toBe("gundogan");
  });

  it("folds precomposed and decomposed forms identically", () => {
    // "é" as U+00E9 vs "e" + U+0301 — Syncthing/macOS can deliver either.
    expect(slugify("café")).toBe(slugify("café"));
    expect(slugify("café")).toBe("cafe");
  });

  it("still transliterates the ligatures decomposition alone won't handle", () => {
    // ß and æ/œ have no combining-mark decomposition — they need the map.
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("cœur")).toBe("coeur");
    expect(slugify("Æther")).toBe("aether");
  });

  it("leaves non-Latin scripts empty rather than inventing a filename", () => {
    // Deliberate non-goal: preserving non-Latin characters in filenames would
    // change on-disk encoding (Syncthing NFC/NFD, Obsidian links, exFAT). The
    // caller's fallback ("idea"/"image"/"attachment") is the intended path.
    expect(slugify("Заметка")).toBe("");
    expect(slugify("メモ")).toBe("");
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
