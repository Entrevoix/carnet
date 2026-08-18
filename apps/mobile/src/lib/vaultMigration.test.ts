import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock expo-file-system/legacy ─────────────────────────────────────────────
// Same in-memory-store approach as writer.test.ts (see its header comment for
// why: react-native's Flow source can't load under vite-node). Both the
// internal root (file:///data/carnet) and the target vault
// (file:///vault) are plain file:// paths here, so this suite never needs
// the SAF stubs writer.test.ts carries for its own coverage.

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

/** captureFolderPath the mocked getSettings() returns — mutated per test to
 * move the migration TARGET. The internal root is always
 * `file:///data/carnet` (documentDirectory below + "/carnet"), independent
 * of this. */
let _captureFolderPath = "file:///vault";

vi.mock("./settings", () => ({
  getSettings: vi.fn(async () => ({
    captureFolderPath: _captureFolderPath,
  })),
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
    makeDirectoryAsync: vi.fn(async () => {
      /* no-op — directories are implicit from tracked file prefixes */
    }),
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
      if (uri.includes("UNREADABLE")) {
        throw new Error("simulated read failure");
      }
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

// ── Mock ./storage (Recents history) ─────────────────────────────────────────
// A minimal id→filepath map, not the real AsyncStorage-backed module (which
// needs its own native-module mock — see storage.test.ts). Only the one
// primitive vaultMigration.ts actually calls is faked here;
// `_updateCaptureFilepathImpl` is swappable per-test so the "remap failure
// doesn't fail migration" case can force a rejection.
const _history: Map<string, string> = new Map(); // filepath -> id, for lookup by filepath

let _updateCaptureFilepathImpl: (
  oldFilepath: string,
  newFilepath: string,
) => Promise<void> = async (oldFilepath, newFilepath) => {
  const id = _history.get(oldFilepath);
  if (id === undefined) return; // no matching entry — silent no-op, as storage.ts does
  _history.delete(oldFilepath);
  _history.set(newFilepath, id);
};

vi.mock("./storage", () => ({
  updateCaptureFilepath: vi.fn(
    async (oldFilepath: string, newFilepath: string) =>
      _updateCaptureFilepathImpl(oldFilepath, newFilepath),
  ),
}));

import { migratePreVaultNotes } from "./vaultMigration";

const INTERNAL = "file:///data/carnet";
const TARGET = "file:///vault";

function seed(uri: string, content: string): void {
  _files.set(uri, { content });
}

function has(uri: string): boolean {
  return _files.has(uri);
}

/** Seed a Recents entry pointing at `filepath`, keyed by a synthetic id. */
function seedHistoryEntry(filepath: string, id: string): void {
  _history.set(filepath, id);
}

beforeEach(() => {
  _files.clear();
  _history.clear();
  _captureFolderPath = TARGET;
  _updateCaptureFilepathImpl = async (oldFilepath, newFilepath) => {
    const id = _history.get(oldFilepath);
    if (id === undefined) return;
    _history.delete(oldFilepath);
    _history.set(newFilepath, id);
  };
});

describe("migratePreVaultNotes", () => {
  it("is a no-op when the internal root has no notes", async () => {
    const result = await migratePreVaultNotes();
    expect(result).toEqual({ migrated: 0, failed: 0, failures: [] });
  });

  it("migrates a single note byte-identically", async () => {
    const md = "---\ncreated: 2026-08-01\ntags: [idea]\n---\n# My Idea\n\nbody\n";
    seed(`${INTERNAL}/Ideas/my-idea.md`, md);

    const result = await migratePreVaultNotes();

    expect(result).toEqual({ migrated: 1, failed: 0, failures: [] });
    expect(has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(false); // source removed
    const targetUri = `${TARGET}/Ideas/my-idea.md`;
    expect(has(targetUri)).toBe(true);
    // Byte-identical: verbatim, not re-serialized.
    expect(_files.get(targetUri)!.content).toBe(md);
  });

  it("migrates a note together with its paired binary", async () => {
    const md =
      "---\ncreated: 2026-08-01\n---\n# Photo\n\n![](../Photos/pic.jpg)\n";
    seed(`${INTERNAL}/Ideas/photo-note.md`, md);
    seed(`${INTERNAL}/Photos/pic.jpg`, "base64-bytes");

    const result = await migratePreVaultNotes();

    expect(result).toEqual({ migrated: 1, failed: 0, failures: [] });
    expect(has(`${INTERNAL}/Photos/pic.jpg`)).toBe(false);
    expect(has(`${TARGET}/Photos/pic.jpg`)).toBe(true);
    expect(_files.get(`${TARGET}/Photos/pic.jpg`)!.content).toBe(
      "base64-bytes",
    );
    // Body link untouched — no rename was needed.
    expect(_files.get(`${TARGET}/Ideas/photo-note.md`)!.content).toBe(md);
  });

  it("collision-bumps the note name when the target already has one", async () => {
    seed(`${TARGET}/Ideas/my-idea.md`, "# Existing target note\n");
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# Migrated note\n");

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    expect(_files.get(`${TARGET}/Ideas/my-idea.md`)!.content).toBe(
      "# Existing target note\n",
    );
    expect(_files.get(`${TARGET}/Ideas/my-idea-2.md`)!.content).toBe(
      "# Migrated note\n",
    );
    expect(has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(false);
  });

  it("collision-bumps a paired binary and rewrites just its link", async () => {
    seed(`${TARGET}/Photos/pic.jpg`, "existing-target-bytes");
    const md = "# Photo\n\n![](../Photos/pic.jpg)\n";
    seed(`${INTERNAL}/Ideas/photo-note.md`, md);
    seed(`${INTERNAL}/Photos/pic.jpg`, "internal-bytes");

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    // Existing target binary untouched.
    expect(_files.get(`${TARGET}/Photos/pic.jpg`)!.content).toBe(
      "existing-target-bytes",
    );
    // Migrated binary landed under the bumped name.
    expect(_files.get(`${TARGET}/Photos/pic-2.jpg`)!.content).toBe(
      "internal-bytes",
    );
    // The note body was rewritten to point at the renamed binary.
    expect(_files.get(`${TARGET}/Ideas/photo-note.md`)!.content).toBe(
      "# Photo\n\n![](../Photos/pic-2.jpg)\n",
    );
  });

  it("collision-suffixes a same-day Journal file instead of merging", async () => {
    const targetDay = "---\ndate: 2026-08-18\n---\n# Existing day\n\nAlready here.\n";
    const migratedDay = "---\ndate: 2026-08-18\n---\n# Pre-vault entry\n\nCaptured earlier.\n";
    seed(`${TARGET}/Journal/2026-08-18.md`, targetDay);
    seed(`${INTERNAL}/Journal/2026-08-18.md`, migratedDay);

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    // Target's existing day file is untouched — no merge, no fabricated
    // "## HH:MM" heading, no dropped frontmatter.
    expect(_files.get(`${TARGET}/Journal/2026-08-18.md`)!.content).toBe(
      targetDay,
    );
    // The migrated day landed as a byte-identical sibling.
    expect(_files.get(`${TARGET}/Journal/2026-08-18-2.md`)!.content).toBe(
      migratedDay,
    );
  });

  it("leaves a note (and its binary) in place on a per-file failure, and reports it", async () => {
    seed(`${INTERNAL}/Ideas/UNREADABLE-note.md`, "# Will fail to read\n");
    seed(`${INTERNAL}/Ideas/good-note.md`, "# Fine\n");

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      {
        subdir: "Ideas",
        name: "UNREADABLE-note.md",
        error: "simulated read failure",
      },
    ]);
    // The failed note's internal copy was NEVER deleted.
    expect(has(`${INTERNAL}/Ideas/UNREADABLE-note.md`)).toBe(true);
    // The good note still migrated normally.
    expect(has(`${INTERNAL}/Ideas/good-note.md`)).toBe(false);
    expect(has(`${TARGET}/Ideas/good-note.md`)).toBe(true);
  });

  it("does nothing when the target resolves to the internal root itself", async () => {
    _captureFolderPath = ""; // resolveRoot() falls back to the internal root
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# Should not move\n");

    const result = await migratePreVaultNotes();

    expect(result).toEqual({ migrated: 0, failed: 0, failures: [] });
    // Source untouched — the self-copy-then-delete guard fired.
    expect(has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(true);
  });

  it("skips Syncthing sync-conflict copies (never migrated, never deleted)", async () => {
    seed(
      `${INTERNAL}/Ideas/note.sync-conflict-20260801-120000-ABC1234.md`,
      "# Conflict copy\n",
    );

    const result = await migratePreVaultNotes();

    expect(result).toEqual({ migrated: 0, failed: 0, failures: [] });
    expect(
      has(`${INTERNAL}/Ideas/note.sync-conflict-20260801-120000-ABC1234.md`),
    ).toBe(true);
  });

  // ── Recents (history) remap ──────────────────────────────────────────────

  it("repoints a Recents entry at the note's new vault path", async () => {
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# My Idea\n");
    seedHistoryEntry(`${INTERNAL}/Ideas/my-idea.md`, "recents-id-1");

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    expect(_history.get(`${TARGET}/Ideas/my-idea.md`)).toBe("recents-id-1");
    expect(_history.has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(false);
  });

  it("repoints a Recents entry at the note's COLLISION-BUMPED vault path", async () => {
    seed(`${TARGET}/Ideas/my-idea.md`, "# Existing target note\n");
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# Migrated note\n");
    seedHistoryEntry(`${INTERNAL}/Ideas/my-idea.md`, "recents-id-2");

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    // Must follow the ACTUAL written path, not the original name.
    expect(_history.get(`${TARGET}/Ideas/my-idea-2.md`)).toBe("recents-id-2");
    expect(_history.has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(false);
  });

  it("is a no-op when the migrated note has no Recents entry", async () => {
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# My Idea\n");
    // No seedHistoryEntry call — nothing in `_history` at all.

    const result = await migratePreVaultNotes();

    expect(result.migrated).toBe(1);
    expect(_history.size).toBe(0);
  });

  it("does not fail the migration when the Recents remap itself rejects", async () => {
    seed(`${INTERNAL}/Ideas/my-idea.md`, "# My Idea\n");
    seedHistoryEntry(`${INTERNAL}/Ideas/my-idea.md`, "recents-id-3");
    _updateCaptureFilepathImpl = async () => {
      throw new Error("simulated AsyncStorage write failure");
    };

    const result = await migratePreVaultNotes();

    // The note migration itself is unaffected — that's the important half.
    expect(result).toEqual({ migrated: 1, failed: 0, failures: [] });
    expect(has(`${INTERNAL}/Ideas/my-idea.md`)).toBe(false);
    expect(has(`${TARGET}/Ideas/my-idea.md`)).toBe(true);
  });
});
