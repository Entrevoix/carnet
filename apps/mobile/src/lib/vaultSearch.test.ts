import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Mirrors vault.test.ts: vault.ts reads notes through ./writer (native) and
// caches through AsyncStorage (native). Replace both with in-memory fakes so
// the note-index + search logic runs in plain Node; ./frontmatter is pure.

interface FakeNote {
  uri: string;
  name: string;
  subdir: "Ideas" | "Journal" | "People";
}

const _notes: Map<string, string> = new Map(); // uri -> markdown
let _listRefs: FakeNote[] = [];
const _unreadable: Set<string> = new Set();

vi.mock("./writer", () => ({
  listNoteFiles: vi.fn(async () => _listRefs),
  readNote: vi.fn(async (uri: string) => {
    if (_unreadable.has(uri)) throw new Error(`unreadable: ${uri}`);
    const md = _notes.get(uri);
    if (md === undefined) throw new Error(`not found: ${uri}`);
    return md;
  }),
}));

const _store: Map<string, string> = new Map();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

import {
  buildNoteIndex,
  getNoteIndex,
  getTagIndex,
  invalidateNoteIndex,
  loadCachedNoteIndex,
  loadCachedTagIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNotes,
  upsertNoteInIndex,
  type NoteIndex,
  type NoteIndexEntry,
} from "./vault";
import { listNoteFiles } from "./writer";

// ── Helpers ───────────────────────────────────────────────────────────────────

function addNote(uri: string, subdir: FakeNote["subdir"], markdown: string): void {
  _notes.set(uri, markdown);
  _listRefs.push({ uri, name: uri.split("/").pop()!, subdir });
}

function reset(): void {
  _notes.clear();
  _store.clear();
  _unreadable.clear();
  _listRefs = [];
  vi.clearAllMocks();
}

beforeEach(reset);

function entryByUri(index: NoteIndex, uri: string): NoteIndexEntry {
  const found = index.notes.find((n) => n.uri === uri);
  if (!found) throw new Error(`no index entry for ${uri}`);
  return found;
}

// ── build parity ──────────────────────────────────────────────────────────────

describe("buildNoteIndex", () => {
  it("captures title, tags, excerpt, mode and subdir per note", async () => {
    addNote(
      "file:///v/Ideas/a.md",
      "Ideas",
      "---\ncreated: 2026-01-02\ntags: [work, 'My Tag']\n---\n# Alpha\n\nFirst body sentence here.\n",
    );
    addNote("file:///v/Journal/2026-05-16.md", "Journal", "Just prose, no heading.\n");

    const index = await buildNoteIndex();
    const a = entryByUri(index, "file:///v/Ideas/a.md");
    expect(a).toEqual({
      uri: "file:///v/Ideas/a.md",
      subdir: "Ideas",
      title: "Alpha",
      createdOrDate: Date.parse("2026-01-02"),
      tags: ["work", "my-tag"],
      mode: "idea",
      excerpt: "First body sentence here.",
    });

    const j = entryByUri(index, "file:///v/Journal/2026-05-16.md");
    expect(j.mode).toBe("journal");
    expect(j.subdir).toBe("Journal");
    expect(j.tags).toEqual([]);
    expect(j.createdOrDate).toBe(0); // no created:/date: frontmatter
    // No frontmatter, no H1 → title is the first body line; excerpt keeps prose.
    expect(j.title).toBe("Just prose, no heading.");
    expect(j.excerpt).toBe("Just prose, no heading.");
  });

  it("caps the excerpt at 200 chars", async () => {
    const long = "x".repeat(500);
    addNote("file:///v/Ideas/long.md", "Ideas", `---\n---\n# T\n\n${long}\n`);
    const index = await buildNoteIndex();
    expect(entryByUri(index, "file:///v/Ideas/long.md").excerpt).toHaveLength(200);
  });

  it("skips unreadable notes but keeps the rest", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\ntags: [keep]\n---\n# Ok\n");
    addNote("file:///v/Ideas/gone.md", "Ideas", "---\ntags: [lost]\n---\n# Gone\n");
    _unreadable.add("file:///v/Ideas/gone.md");
    const index = await buildNoteIndex();
    expect(index.notes.map((n) => n.uri)).toEqual(["file:///v/Ideas/ok.md"]);
  });
});

// ── cache-first read ──────────────────────────────────────────────────────────

describe("note index cache", () => {
  it("getNoteIndex builds + caches on a cold miss, then serves the cache without rescanning", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    const first = await getNoteIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();

    const second = await getNoteIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce(); // no second scan
    expect(second).toEqual(first);
  });

  it("loadCachedNoteIndex returns null before any build and tolerates corrupt JSON", async () => {
    expect(await loadCachedNoteIndex()).toBeNull();
    _store.set("carnet:noteindex:v1", "{not json");
    expect(await loadCachedNoteIndex()).toBeNull();
  });

  it("invalidateNoteIndex drops the cache so the next read rebuilds", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    expect(await loadCachedNoteIndex()).not.toBeNull();
    await invalidateNoteIndex();
    expect(await loadCachedNoteIndex()).toBeNull();
  });
});

// ── incremental upsert ────────────────────────────────────────────────────────

describe("upsertNoteInIndex", () => {
  it("adds a freshly written note without a full vault rescan", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    vi.clearAllMocks(); // forget the build's listNoteFiles call

    await upsertNoteInIndex(
      "file:///v/Ideas/new.md",
      "---\ncreated: 2026-06-01\ntags: [fresh]\n---\n# New\n\nBrand new note.\n",
    );

    expect(listNoteFiles).not.toHaveBeenCalled(); // common path never rescans
    const index = await loadCachedNoteIndex();
    const entry = entryByUri(index!, "file:///v/Ideas/new.md");
    expect(entry.title).toBe("New");
    expect(entry.tags).toEqual(["fresh"]);
    expect(entry.mode).toBe("idea");
  });

  it("replaces the existing row for a URI rather than duplicating it", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [old]\n---\n# Old title\n");
    await refreshNoteIndex();

    await upsertNoteInIndex("file:///v/Ideas/a.md", "---\ntags: [new]\n---\n# New title\n");
    const index = await loadCachedNoteIndex();
    const rows = index!.notes.filter((n) => n.uri === "file:///v/Ideas/a.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New title");
    expect(rows[0].tags).toEqual(["new"]);
  });

  it("is a no-op when no index is cached yet (avoids a rescan)", async () => {
    await upsertNoteInIndex("file:///v/Ideas/a.md", "---\ntags: [x]\n---\n# A\n");
    expect(listNoteFiles).not.toHaveBeenCalled();
    expect(await loadCachedNoteIndex()).toBeNull();
  });
});

// ── ranking ───────────────────────────────────────────────────────────────────

describe("searchNotes ranking", () => {
  function idx(notes: NoteIndexEntry[]): NoteIndex {
    return { builtAt: 0, notes };
  }
  function note(over: Partial<NoteIndexEntry>): NoteIndexEntry {
    return {
      uri: over.uri ?? "file:///v/Ideas/x.md",
      subdir: over.subdir ?? "Ideas",
      title: over.title ?? "",
      createdOrDate: over.createdOrDate ?? 0,
      tags: over.tags ?? [],
      mode: over.mode ?? "idea",
      excerpt: over.excerpt ?? "",
    };
  }

  it("ranks title matches above tag matches above excerpt matches", async () => {
    const index = idx([
      note({ uri: "e", excerpt: "mentions carnet in the body" }),
      note({ uri: "t", tags: ["carnet"] }),
      note({ uri: "ti", title: "carnet roadmap" }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["ti", "t", "e"]);
  });

  it("ranks a title prefix ahead of a title substring", async () => {
    const index = idx([
      note({ uri: "sub", title: "my carnet notes" }),
      note({ uri: "pre", title: "carnet notes" }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["pre", "sub"]);
  });

  it("breaks ties newest-first", async () => {
    const index = idx([
      note({ uri: "old", title: "carnet a", createdOrDate: 100 }),
      note({ uri: "new", title: "carnet b", createdOrDate: 200 }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["new", "old"]);
  });

  it("filters by mode before ranking", async () => {
    const index = idx([
      note({ uri: "idea", title: "carnet idea", mode: "idea" }),
      note({ uri: "journal", title: "carnet journal", mode: "journal" }),
    ]);
    expect(searchNotes(index, "carnet", { mode: "journal" }).map((n) => n.uri)).toEqual(["journal"]);
  });

  it("returns every filtered note newest-first for an empty query (browse)", async () => {
    const index = idx([
      note({ uri: "a", title: "a", createdOrDate: 1 }),
      note({ uri: "b", title: "b", createdOrDate: 2 }),
    ]);
    expect(searchNotes(index, "  ").map((n) => n.uri)).toEqual(["b", "a"]);
  });

  it("excludes non-matching notes", async () => {
    const index = idx([note({ uri: "a", title: "unrelated", excerpt: "nothing here" })]);
    expect(searchNotes(index, "carnet")).toEqual([]);
  });
});

// ── result navigation ─────────────────────────────────────────────────────────

describe("resolveNoteEntry", () => {
  it("adapts an indexed note URI into the CaptureEntry RecentDetail expects", async () => {
    addNote("file:///v/Ideas/my-idea.md", "Ideas", "---\ncreated: 2026-05-08\n---\n# My Idea\n\nbody\n");
    const index = await buildNoteIndex();
    const hit = searchNotes(index, "my idea")[0];

    const entry = await resolveNoteEntry(hit.uri);
    expect(entry).toEqual({
      id: "vault:file:///v/Ideas/my-idea.md",
      mode: "idea",
      title: "My Idea",
      filepath: "file:///v/Ideas/my-idea.md",
      createdAt: Date.parse("2026-05-08"),
    });
  });

  it("returns null when the note became unreadable since indexing", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# A\n");
    await buildNoteIndex();
    _unreadable.add("file:///v/Ideas/a.md");
    expect(await resolveNoteEntry("file:///v/Ideas/a.md")).toBeNull();
  });
});

// ── fold-in regression: tag index derived from the note index ─────────────────

describe("tag index derived from note index (fold-in)", () => {
  it("getTagIndex reflects the same notes/tags as the note index", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work, idea]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [work]\n---\n# B\n");
    addNote("file:///v/Journal/c.md", "Journal", "---\ntags:\n  - idea\n---\n# C\n");

    const tagIndex = await getTagIndex();
    expect(Object.fromEntries(tagIndex.tags.map((t) => [t.tag, t.count]))).toEqual({
      work: 2,
      idea: 2,
    });
  });

  it("upsert keeps the derived tag index fresh without a separate scan", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    await upsertNoteInIndex("file:///v/Ideas/b.md", "---\ntags: [work, new]\n---\n# B\n");

    const tagIndex = await loadCachedTagIndex();
    expect(tagIndex).not.toBeNull();
    expect(Object.fromEntries(tagIndex!.tags.map((t) => [t.tag, t.count]))).toEqual({
      work: 2,
      new: 1,
    });
  });
});
