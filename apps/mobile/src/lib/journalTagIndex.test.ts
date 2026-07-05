import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Integration regression: journal same-day tag accumulation → note index ──────
//
// Reproduces the HIGH-severity bug where a second same-day journal capture
// silently dropped the first capture's tags from the derived tag/search index.
//
// The bug lived in the seam between two real modules:
//   - writer.appendJournal accumulates every same-day capture into ONE day file,
//     unioning their frontmatter tags. But it used to return only { filepath },
//     so the caller had no handle on the accumulated markdown.
//   - CaptureScreen's journal branch then called upsertNoteInIndex(filepath, X).
//     With only { filepath } available it passed the just-written FRAGMENT as X,
//     so buildNoteEntry(tagsForNote(fragment)) saw only the newest capture's
//     tags and overwrote the note's index row — dropping earlier same-day tags.
//
// This test runs the REAL appendJournal (against an in-memory fs) and the REAL
// vault note-index functions (upsertNoteInIndex / getNoteIndex / getTagIndex),
// wired exactly as the journal confirmSave branch wires them:
//     const { filepath, markdown } = await appendJournal(date, fragment);
//     await upsertNoteInIndex(filepath, markdown);
// It is NOT a synthetic upsertNoteInIndex(uri, accumulated) call — the markdown
// it indexes off is whatever appendJournal returns, which is the exact value
// the fix changes. Against the unfixed code (appendJournal returns no markdown)
// the index would carry only the second tag; the assertions below fail.

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

// Mock ./settings before importing writer.ts so vite-node never loads the real
// settings.ts → expo-secure-store → react-native chain (mirrors writer.test.ts).
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
      if (_files.has(uri)) return { exists: true, uri, isDirectory: false };
      const dirPrefix = uri.replace(/\/$/, "") + "/";
      const isDir = [..._files.keys()].some((u) => u.startsWith(dirPrefix));
      return { exists: isDir, uri, isDirectory: isDir };
    }),
    makeDirectoryAsync: vi.fn(async () => {}),
    readDirectoryAsync: vi.fn(async (parentUri: string) => {
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
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(),
      makeDirectoryAsync: vi.fn(),
      createFileAsync: vi.fn(),
      readAsStringAsync: vi.fn(),
      writeAsStringAsync: vi.fn(),
    },
  };
});

// vault.ts caches the note index through AsyncStorage — back it with an
// in-memory store so the incremental upsert path has a cache to mutate.
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

import { appendJournal } from "./writer";
import { getNoteIndex, getTagIndex, upsertNoteInIndex, buildTagIndex } from "./vault";

const DATE = "2026-05-16";

function journalFragment(tag: string, body: string): string {
  return `---\ntags: [${tag}]\n---\n\n# Journal\n\n${body}\n`;
}

/**
 * Model one journal capture exactly as CaptureScreen's confirmSave journal
 * branch does: write via appendJournal, then index off the markdown it returns.
 * Returns the day file's URI (stable across same-day captures).
 */
async function captureJournal(fragment: string): Promise<string> {
  const { filepath, markdown } = await appendJournal(DATE, fragment);
  await upsertNoteInIndex(filepath, markdown);
  return filepath;
}

function tagsForUriInNoteIndexNotes(
  notes: ReadonlyArray<{ uri: string; tags: string[] }>,
  uri: string,
): string[] {
  const entry = notes.find((n) => n.uri === uri);
  return entry ? [...entry.tags].sort() : [];
}

describe("journal same-day captures keep every tag in the note index", () => {
  beforeEach(() => {
    _files.clear();
    _store.clear();
  });

  it("second same-day capture (tag b) does not drop the first capture's tag (a)", async () => {
    // The screen primes the cached note index on mount (getTagIndex). Without a
    // cached index the incremental upsert is a no-op, so mirror that priming.
    await getTagIndex();

    // Capture 1, tagged `a`.
    const journalUri = await captureJournal(journalFragment("a", "First entry of the day."));
    // Capture 2, later the same day, tagged `b` — same day file.
    await captureJournal(journalFragment("b", "Second entry of the day."));

    // The cached note index (what the tag browser + search read) must carry the
    // day file with BOTH tags — not just the most recent capture's `b`.
    const noteIndex = await getNoteIndex();
    expect(tagsForUriInNoteIndexNotes(noteIndex.notes, journalUri)).toEqual(["a", "b"]);

    const tagIndex = await getTagIndex();
    const tags = tagIndex.tags.map((t) => t.tag).sort();
    expect(tags).toContain("a");
    expect(tags).toContain("b");
  });

  it("cached index matches a full rebuild (source of truth) after two same-day captures", async () => {
    await getTagIndex();
    await captureJournal(journalFragment("a", "Morning note."));
    await captureJournal(journalFragment("b", "Evening note."));

    // buildTagIndex re-reads the actual file (which correctly holds [a, b]).
    // The incrementally-maintained cache must agree with it — the bug was the
    // two diverging (rebuild [a, b], cache [b]).
    const rebuilt = (await buildTagIndex()).tags.map((t) => t.tag).sort();
    const cached = (await getTagIndex()).tags.map((t) => t.tag).sort();
    expect(cached).toEqual(rebuilt);
    expect(rebuilt).toEqual(["a", "b"]);
  });
});
