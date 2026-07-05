import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory expo-file-system mock WITH modificationTime tracking ───────────
// Mirrors writer.test.ts's store, but each write bumps a monotonic clock so the
// mtime conflict guard (getModificationTime / updateNoteIfUnchanged) is testable
// and external edits can be simulated by bumping a file's mtime directly.

interface FileEntry {
  content: string;
  mtime: number;
}

const _files: Map<string, FileEntry> = new Map();
let _clock = 1000;

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    captureFolderPath: "",
  }),
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  getInfoAsync: vi.fn(async (uri: string) => {
    const entry = _files.get(uri);
    if (entry) {
      return {
        exists: true,
        uri,
        isDirectory: false,
        size: entry.content.length,
        modificationTime: entry.mtime,
      };
    }
    // Model directories: a path is a directory iff some tracked file lives under it.
    const dirPrefix = uri.replace(/\/$/, "") + "/";
    const isDir = [..._files.keys()].some((u) => u.startsWith(dirPrefix));
    return { exists: isDir, uri, isDirectory: isDir, size: 0, modificationTime: 0 };
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
    _files.set(uri, { content, mtime: ++_clock });
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
}));

// ── Mock omniroute (ideaSaveFirst imports enrichIdea + error classifiers) ─────

const enrichIdeaMock = vi.fn();
const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./omniroute", () => ({
  enrichIdea: (...args: unknown[]) => enrichIdeaMock(...args),
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
}));

import {
  applyEnrichedIdea,
  buildRawIdeaMarkdown,
  deriveRawIdeaSlug,
  enrichIdeaInPlace,
  PENDING_ENRICH_STATUS,
  usesSaveFirst,
  writeRawIdea,
} from "./ideaSaveFirst";
import { getModificationTime, updateNoteIfUnchanged, readNote } from "./writer";

function clearFiles(): void {
  _files.clear();
  _clock = 1000;
}

beforeEach(() => {
  clearFiles();
  enrichIdeaMock.mockReset();
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
});

// ── usesSaveFirst (drives the CaptureScreen branch) ──────────────────────────

describe("usesSaveFirst", () => {
  it("is save-first by default (previewBeforeSave off)", () => {
    expect(usesSaveFirst(false)).toBe(true);
  });

  it("restores the blocking preview flow when previewBeforeSave is on", () => {
    // Required test 4: previewBeforeSave=on reproduces the old blocking flow
    // (the raw note is NOT written up front — the caller enriches then previews).
    expect(usesSaveFirst(true)).toBe(false);
  });
});

// ── deriveRawIdeaSlug ─────────────────────────────────────────────────────────

describe("deriveRawIdeaSlug", () => {
  it("slugs from the raw text's first non-empty line (not an LLM title)", () => {
    expect(deriveRawIdeaSlug("Build a kite\n\nmore detail")).toBe("build-a-kite");
  });

  it("falls back to 'idea' for text that slugifies to nothing", () => {
    expect(deriveRawIdeaSlug("🚀")).toBe("idea");
  });
});

// ── buildRawIdeaMarkdown ──────────────────────────────────────────────────────

describe("buildRawIdeaMarkdown", () => {
  const NOW = new Date("2026-07-04T12:00:00.000Z");

  it("writes deterministic client-side frontmatter + the raw text as body", () => {
    const md = buildRawIdeaMarkdown({ text: "My raw idea", tags: [] }, NOW);
    expect(md).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(md).toContain("created: 2026-07-04T12:00:00.000Z");
    expect(md).toContain("My raw idea");
  });

  it("injects user tags and location deterministically", () => {
    const md = buildRawIdeaMarkdown(
      { text: "idea", tags: ["work", "urgent"], location: "38.90000,-77.00000" },
      NOW,
    );
    expect(md).toContain("tags: [work, urgent]");
    expect(md).toContain("location: 38.90000,-77.00000");
  });
});

// ── writeRawIdea — the save-first write lands immediately ─────────────────────

describe("writeRawIdea (save-first write)", () => {
  it("writes the raw note to disk before any enrichment (required test 1)", async () => {
    const { filepath, slug, mtime } = await writeRawIdea({
      text: "Ship the save-first path",
      tags: ["b4"],
    });
    // File is on disk immediately — no enrichment has run.
    expect(_files.has(filepath)).toBe(true);
    expect(slug).toBe("ship-the-save-first-path");
    expect(mtime).not.toBeNull();
    const content = _files.get(filepath)!.content;
    expect(content).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(content).toContain("Ship the save-first path");
    expect(content).toContain("tags: [b4]");
  });
});

// ── applyEnrichedIdea — in-place update, no rename, guarded ───────────────────

describe("applyEnrichedIdea (in-place enriched update)", () => {
  it("updates the SAME file, keeps the filename, preserves user tags + location (required test 2)", async () => {
    const { filepath, mtime } = await writeRawIdea({
      text: "Kite idea",
      tags: ["hobby"],
      location: "40.00000,-74.00000",
    });

    const enriched =
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [kites]\n---\n# Building a Box Kite\n\nStructured body.\n";
    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      enrichedMarkdown: enriched,
      tags: ["hobby"],
      location: "40.00000,-74.00000",
    });

    expect(status).toBe("updated");
    // Same file — no rename to the polished title.
    expect(filepath).toMatch(/Ideas\/kite-idea\.md$/);
    const content = _files.get(filepath)!.content;
    // Enriched body replaced the raw body.
    expect(content).toContain("# Building a Box Kite");
    expect(content).not.toContain(`status: ${PENDING_ENRICH_STATUS}`);
    // User tags merged with the LLM's, user location preserved.
    expect(content).toContain("hobby");
    expect(content).toContain("kites");
    expect(content).toContain("location: 40.00000,-74.00000");
  });

  it("keeps the user's version and reports conflict when mtime changed (required test 3)", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "Race me", tags: [] });

    // Simulate an external touch (a synced workstation edit) between the raw
    // write and the enriched overwrite: content + mtime both change.
    _files.set(filepath, { content: "# Workstation edit\n", mtime: mtime! + 5 });

    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      enrichedMarkdown: "# Enriched clobber\n",
      tags: [],
    });

    expect(status).toBe("conflict");
    // The enriched write was skipped — the user's version survived, no clobber.
    expect(_files.get(filepath)!.content).toBe("# Workstation edit\n");
  });
});

// ── updateNoteIfUnchanged — the raw mtime guard primitive ────────────────────

describe("updateNoteIfUnchanged (mtime guard)", () => {
  it("writes when the mtime still matches the baseline", async () => {
    const { filepath } = await writeRawIdea({ text: "guard me", tags: [] });
    const baseline = await getModificationTime(filepath);
    const res = await updateNoteIfUnchanged(filepath, "# Updated\n", baseline);
    expect(res.ok).toBe(true);
    expect(await readNote(filepath)).toBe("# Updated\n");
  });

  it("skips the write and reports conflict when the file changed under it", async () => {
    const { filepath } = await writeRawIdea({ text: "guard me", tags: [] });
    const baseline = await getModificationTime(filepath);
    // External edit bumps mtime.
    _files.set(filepath, { content: "# Theirs\n", mtime: (baseline ?? 0) + 9 });
    const res = await updateNoteIfUnchanged(filepath, "# Mine\n", baseline);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("conflict");
    expect(await readNote(filepath)).toBe("# Theirs\n");
  });

  it("proceeds when the baseline is null (guard cannot fire, e.g. SAF)", async () => {
    const { filepath } = await writeRawIdea({ text: "no baseline", tags: [] });
    const res = await updateNoteIfUnchanged(filepath, "# Forced\n", null);
    expect(res.ok).toBe(true);
    expect(await readNote(filepath)).toBe("# Forced\n");
  });
});

// ── enrichIdeaInPlace — full async enrichment, ordering + failure classes ─────

describe("enrichIdeaInPlace", () => {
  it("only runs enrichment after the raw note is already on disk", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "ordering", tags: [] });
    let fileExistedAtEnrichTime = false;
    enrichIdeaMock.mockImplementation(async () => {
      fileExistedAtEnrichTime = _files.has(filepath);
      return { markdown: "# Enriched\n\nbody\n", model: "test" };
    });

    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "ordering",
      tags: [],
    });

    expect(fileExistedAtEnrichTime).toBe(true);
    expect(outcome.kind).toBe("updated");
    expect(_files.get(filepath)!.content).toContain("# Enriched");
  });

  it("classifies a network failure as transient (caller should queue)", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "offline", tags: [] });
    enrichIdeaMock.mockRejectedValue(new Error("network down"));
    // Neither permanent nor not-configured → transient.
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "offline",
      tags: [],
    });
    expect(outcome).toEqual({ kind: "failed", transient: true, reason: "network down" });
    // Raw note untouched — still pending-enrich, nothing lost.
    expect(_files.get(filepath)!.content).toContain(`status: ${PENDING_ENRICH_STATUS}`);
  });

  it("classifies a permanent (4xx) failure as non-transient", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "badreq", tags: [] });
    enrichIdeaMock.mockRejectedValue(new Error("HTTP 400"));
    isPermanentErrorMock.mockReturnValue(true);
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "badreq",
      tags: [],
    });
    expect(outcome).toEqual({ kind: "failed", transient: false, reason: "HTTP 400" });
  });

  it("reports conflict (keeps user version) when the note changed during enrichment", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "conflict", tags: [] });
    enrichIdeaMock.mockImplementation(async () => {
      // The workstation edit syncs in while enrichment is in flight.
      _files.set(filepath, { content: "# Theirs\n", mtime: mtime! + 3 });
      return { markdown: "# Mine\n", model: "test" };
    });
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "conflict",
      tags: [],
    });
    expect(outcome.kind).toBe("conflict");
    expect(_files.get(filepath)!.content).toBe("# Theirs\n");
  });
});
