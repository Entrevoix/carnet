import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vault.ts reads notes through ./writer (native: expo-file-system) and caches
// through AsyncStorage (native). Replace both with in-memory fakes so the index
// logic is exercised in plain Node. ./frontmatter is pure and used for real.

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
  buildTagIndex,
  getTagIndex,
  loadCachedTagIndex,
  refreshTagIndex,
  suggestTags,
  tagsForNote,
  type TagIndex,
} from "./vault";
import { listNoteFiles, readNote } from "./writer";

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

// ── buildTagIndex ─────────────────────────────────────────────────────────────

describe("buildTagIndex", () => {
  it("counts each tag once per note across the vault", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work, idea]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [work]\n---\n# B\n");
    addNote("file:///v/Journal/c.md", "Journal", "---\ntags:\n  - idea\n---\n# C\n");

    const index = await buildTagIndex();
    const byTag = Object.fromEntries(index.tags.map((t) => [t.tag, t.count]));
    expect(byTag).toEqual({ work: 2, idea: 2 });
  });

  it("sorts by count desc, then tag asc", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [zebra, alpha, common]\n---\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [common]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags.map((t) => t.tag)).toEqual(["common", "alpha", "zebra"]);
  });

  it("normalizes tags before counting (case/space folded together)", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: ['My Tag']\n---\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [my-tag]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags).toEqual([
      { tag: "my-tag", count: 2, files: ["file:///v/Ideas/a.md", "file:///v/Ideas/b.md"] },
    ]);
  });

  it("ignores notes with no frontmatter / no tags", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "# Just a title\n\nbody\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\nkind: idea\n---\n# B\n");
    const index = await buildTagIndex();
    expect(index.tags).toEqual([]);
  });

  it("skips unreadable notes instead of failing the whole scan", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\ntags: [keep]\n---\n");
    addNote("file:///v/Ideas/gone.md", "Ideas", "---\ntags: [lost]\n---\n");
    _unreadable.add("file:///v/Ideas/gone.md");

    const index = await buildTagIndex();
    expect(index.tags.map((t) => t.tag)).toEqual(["keep"]);
  });

  it("records the carrying note URIs per tag", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [shared]\n---\n");
    addNote("file:///v/People/b.md", "People", "---\ntags: [shared]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags[0].files.sort()).toEqual([
      "file:///v/Ideas/a.md",
      "file:///v/People/b.md",
    ]);
  });

  it("reads every note even when the count exceeds the concurrency limit", async () => {
    for (let i = 0; i < 25; i++) {
      addNote(`file:///v/Ideas/n${i}.md`, "Ideas", `---\ntags: [t${i % 3}]\n---\n`);
    }
    const index = await buildTagIndex();
    expect(readNote).toHaveBeenCalledTimes(25);
    const total = index.tags.reduce((sum, t) => sum + t.count, 0);
    expect(total).toBe(25);
  });

  it("returns an empty index for an empty vault", async () => {
    const index = await buildTagIndex();
    expect(index.tags).toEqual([]);
    expect(listNoteFiles).toHaveBeenCalledOnce();
  });
});

// ── caching ───────────────────────────────────────────────────────────────────

describe("tag index cache", () => {
  it("loadCachedTagIndex returns null before any build", async () => {
    expect(await loadCachedTagIndex()).toBeNull();
  });

  it("refreshTagIndex persists and is read back by loadCachedTagIndex", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n");
    const built = await refreshTagIndex();
    const cached = await loadCachedTagIndex();
    expect(cached).toEqual(built);
    expect(cached!.tags[0].tag).toBe("work");
  });

  it("getTagIndex builds + caches on a cold miss, then serves the cache", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n");
    const first = await getTagIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();

    // Second call should hit the cache — no further vault scan.
    const second = await getTagIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it("loadCachedTagIndex tolerates corrupt cache JSON", async () => {
    _store.set("carnet:tagindex:v1", "{not json");
    expect(await loadCachedTagIndex()).toBeNull();
  });
});

// ── suggestTags ───────────────────────────────────────────────────────────────

describe("suggestTags", () => {
  const index: TagIndex = {
    builtAt: 0,
    tags: [
      { tag: "work", count: 5, files: [] },
      { tag: "workout", count: 3, files: [] },
      { tag: "homework", count: 2, files: [] },
      { tag: "idea", count: 1, files: [] },
    ],
  };

  it("returns most-used tags for an empty query", () => {
    expect(suggestTags(index, "", 2)).toEqual(["work", "workout"]);
  });

  it("prefix matches rank ahead of substring matches", () => {
    expect(suggestTags(index, "work")).toEqual(["work", "workout", "homework"]);
  });

  it("normalizes the query before matching", () => {
    expect(suggestTags(index, "  WORK ")).toEqual(["work", "workout", "homework"]);
  });

  it("respects the limit", () => {
    expect(suggestTags(index, "work", 1)).toEqual(["work"]);
  });

  it("returns [] when nothing matches", () => {
    expect(suggestTags(index, "zzz")).toEqual([]);
  });
});

// ── tagsForNote ───────────────────────────────────────────────────────────────

describe("tagsForNote", () => {
  it("returns distinct normalized tags for a note", () => {
    expect(tagsForNote("---\ntags: ['My Tag', my-tag, Work]\n---\n# T\n")).toEqual([
      "my-tag",
      "work",
    ]);
  });

  it("returns [] for a note with no tags", () => {
    expect(tagsForNote("# Just prose\n")).toEqual([]);
  });
});
