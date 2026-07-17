import { describe, expect, it } from "vitest";

import {
  findRelatedNotes,
  significantTerms,
  RELATED_NOTES_LIMIT,
} from "./relatedNotes";
import type { NoteIndex, NoteIndexEntry } from "./vault";

function entry(over: Partial<NoteIndexEntry> & { uri: string }): NoteIndexEntry {
  return {
    subdir: "Ideas",
    title: "",
    createdOrDate: 0,
    tags: [],
    mode: "idea",
    excerpt: "",
    status: null,
    ...over,
  } as NoteIndexEntry;
}

const index = (...notes: NoteIndexEntry[]): NoteIndex => ({
  builtAt: 1,
  notes,
});

describe("significantTerms", () => {
  it("lowercases, splits on non-letters, drops short words", () => {
    expect(significantTerms("The Garden-Shed project, v2!")).toEqual(
      new Set(["garden", "shed", "project"]),
    );
  });

  it("handles accents and unicode word characters", () => {
    expect(significantTerms("Mémoire vive")).toEqual(
      new Set(["mémoire", "vive"]),
    );
  });
});

describe("findRelatedNotes", () => {
  const query = {
    uri: "file:///v/Ideas/current.md",
    title: "Garden shed solar panels",
    tags: ["garden", "energy"],
  };

  it("never returns the note being viewed", () => {
    const self = entry({ uri: query.uri, title: query.title, tags: [...query.tags] });
    expect(findRelatedNotes(query, index(self))).toEqual([]);
  });

  it("excludes self even when the two URI sources disagree on percent-encoding (SAF)", () => {
    // Write-path URI (recents history) vs listing-path URI (index) — same
    // document, different encoding. Without the basename fallback the open
    // note would be its own top hit.
    const writePathQuery = {
      uri: "content://auth/tree/primary%3ACarnet/document/primary%3ACarnet%2FIdeas%2Fsolar.md",
      subdir: "Ideas",
      title: "Garden shed solar panels",
      tags: ["garden"],
    };
    const listingForm = entry({
      uri: "content://auth/tree/primary%3ACarnet/document/primary:Carnet%2FIdeas%2Fsolar.md",
      title: "Garden shed solar panels",
      tags: ["garden"],
    });
    expect(findRelatedNotes(writePathQuery, index(listingForm))).toEqual([]);
  });

  it("does NOT exclude a same-named note in a DIFFERENT subdir", () => {
    const sameNameElsewhere = entry({
      uri: "content://auth/tree/primary%3ACarnet/document/primary%3ACarnet%2FJournal%2Fcurrent.md",
      subdir: "Journal",
      title: "Garden shed solar panels",
      tags: ["garden"],
    });
    const q = { ...query, uri: "content://auth/tree/primary%3ACarnet/document/primary%3ACarnet%2FIdeas%2Fcurrent.md", subdir: "Ideas" };
    expect(findRelatedNotes(q, index(sameNameElsewhere))).toHaveLength(1);
  });

  it("returns nothing when nothing scores — no newest-notes filler", () => {
    const unrelated = entry({ uri: "file:///v/Ideas/x.md", title: "Sourdough starter", tags: ["baking"] });
    expect(findRelatedNotes(query, index(unrelated))).toEqual([]);
  });

  it("ranks shared tags above title-term overlap", () => {
    const byTag = entry({ uri: "file:///a.md", title: "Compost timing", tags: ["garden"] });
    const byTitle = entry({ uri: "file:///b.md", title: "Solar for the balcony", tags: [] });
    const got = findRelatedNotes(query, index(byTitle, byTag));
    expect(got.map((e) => e.uri)).toEqual(["file:///a.md", "file:///b.md"]);
  });

  it("counts excerpt overlap, but not terms already credited via the title", () => {
    // "solar" in title AND excerpt → only the title credit (2), not 2+1.
    const doubled = entry({
      uri: "file:///a.md",
      title: "Solar quotes",
      excerpt: "solar quotes from three installers",
    });
    // Two distinct excerpt-only hits ("garden", "panels") → 1+1... but a
    // single tag match (3) + nothing else must still outrank them.
    const excerptOnly = entry({
      uri: "file:///b.md",
      title: "Weekend list",
      excerpt: "fix the garden gate, clean the panels",
    });
    const tagOnly = entry({ uri: "file:///c.md", title: "Bills", tags: ["energy"] });
    const got = findRelatedNotes(query, index(doubled, excerptOnly, tagOnly));
    expect(got[0].uri).toBe("file:///c.md");
  });

  it("caps at the limit, breaking score ties by recency", () => {
    const notes = [1, 2, 3, 4, 5].map((n) =>
      entry({
        uri: `file:///v/Ideas/${n}.md`,
        title: "Garden ideas",
        createdOrDate: n,
      }),
    );
    const got = findRelatedNotes(query, index(...notes));
    expect(got).toHaveLength(RELATED_NOTES_LIMIT);
    // Same score everywhere → newest first.
    expect(got.map((e) => e.createdOrDate)).toEqual([5, 4, 3]);
  });
});
