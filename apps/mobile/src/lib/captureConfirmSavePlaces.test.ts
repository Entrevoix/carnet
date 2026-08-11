/**
 * The cross-entry Places test, run against the REAL writer (in-memory FS)
 * rather than the mocked one in captureConfirmSave.test.ts.
 *
 * Why its own file: `## Places` is an H2, the same level appendJournal uses for
 * its `## HH:MM` entry headings, and upsertSection replaces the FIRST matching
 * heading in a document. If places were ever injected into the accumulated day
 * file instead of each entry's own fragment, the second same-day capture would
 * silently overwrite the first entry's places. Only the real appendJournal +
 * real upsertSection can prove that doesn't happen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

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
    makeDirectoryAsync: vi.fn(async () => undefined),
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

import { confirmSaveJournal } from "./captureConfirmSave";
import type { Place } from "./writer";

const rudAlpe: Place = { name: "Rud-Alpe", coords: { lat: 47.2011, lon: 10.1166 } };
const lech: Place = { name: "Lech", coords: { lat: 47.2063, lon: 10.1435 } };
const zurs: Place = { name: "Zürs", coords: { lat: 47.1667, lon: 10.1833 } };

beforeEach(() => {
  _files.clear();
});

describe("confirmSaveJournal places (real writer)", () => {
  it("keeps each same-day entry's places independent in the day file", async () => {
    await confirmSaveJournal({
      date: "2026-08-11",
      markdown: "# Morning\n\nSkinned up early.\n",
      refs: [],
      tags: [],
      location: null,
      places: [rudAlpe],
    });

    const second = await confirmSaveJournal({
      date: "2026-08-11",
      markdown: "# Afternoon\n\nLunch, then down.\n",
      refs: [],
      tags: [],
      location: null,
      places: [lech, zurs],
    });

    const dayFile = second.markdown;

    // Both entries landed in one day file...
    expect(dayFile).toContain("Skinned up early.");
    expect(dayFile).toContain("Lunch, then down.");
    // ...each keeping its OWN places — the first entry's was NOT overwritten.
    expect(dayFile).toContain("[Rud-Alpe](geo:47.20110,10.11660)");
    expect(dayFile).toContain("[Lech](geo:47.20630,10.14350)");
    expect(dayFile).toContain("[Zürs](geo:47.16670,10.18330)");
    // Two distinct Places sections, one per entry.
    expect(dayFile.match(/^## Places$/gm)?.length).toBe(2);

    // Each Places section sits inside its own entry, after that entry's prose.
    const firstPlacesIdx = dayFile.indexOf("[Rud-Alpe]");
    const secondEntryIdx = dayFile.indexOf("Lunch, then down.");
    expect(firstPlacesIdx).toBeLessThan(secondEntryIdx);
    expect(dayFile.indexOf("[Lech]")).toBeGreaterThan(secondEntryIdx);
  });

  it("writes no Places section when the entry has none", async () => {
    const result = await confirmSaveJournal({
      date: "2026-08-11",
      markdown: "# Quiet day\n\nNothing to report.\n",
      refs: [],
      tags: [],
      location: null,
      places: [],
    });
    expect(result.markdown).not.toContain("## Places");
  });

  it("leaves a same-day entry without places untouched by a later entry with places", async () => {
    await confirmSaveJournal({
      date: "2026-08-11",
      markdown: "# First\n\nNo places here.\n",
      refs: [],
      tags: [],
      location: null,
      places: [],
    });
    const second = await confirmSaveJournal({
      date: "2026-08-11",
      markdown: "# Second\n\nWent out.\n",
      refs: [],
      tags: [],
      location: null,
      places: [lech],
    });

    expect(second.markdown.match(/^## Places$/gm)?.length).toBe(1);
    expect(second.markdown.indexOf("[Lech]")).toBeGreaterThan(
      second.markdown.indexOf("Went out."),
    );
  });
});
