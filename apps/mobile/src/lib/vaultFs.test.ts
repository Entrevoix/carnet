import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system/legacy", () => {
  return {
    EncodingType: { UTF8: "utf8", Base64: "base64" },
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(),
      makeDirectoryAsync: vi.fn(),
      createFileAsync: vi.fn(),
      readAsStringAsync: vi.fn(),
      writeAsStringAsync: vi.fn(),
      deleteAsync: vi.fn(),
    },
    readDirectoryAsync: vi.fn(),
    getInfoAsync: vi.fn(),
    makeDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    deleteAsync: vi.fn(),
  };
});

import * as FileSystem from "expo-file-system/legacy";
import { vaultFsFor } from "./vaultFs";

const saf = FileSystem.StorageAccessFramework;

describe("safFs.findOrCreateSubdir", () => {
  beforeEach(() => {
    vi.mocked(saf.readDirectoryAsync).mockReset();
    vi.mocked(saf.makeDirectoryAsync).mockReset();
  });

  it("creates a subdir once when called concurrently for the same not-yet-existing name", async () => {
    // Neither concurrent caller sees the folder yet — this is the race window.
    vi.mocked(saf.readDirectoryAsync).mockResolvedValue([]);
    vi.mocked(saf.makeDirectoryAsync).mockResolvedValue(
      "content://authority/tree/primary%3Acarnet/document/primary%3Acarnet%2FJournal",
    );

    const fs = vaultFsFor(true);
    const [a, b] = await Promise.all([
      fs.findOrCreateSubdir("content://authority/tree/primary%3Acarnet", "Journal"),
      fs.findOrCreateSubdir("content://authority/tree/primary%3Acarnet", "Journal"),
    ]);

    expect(saf.makeDirectoryAsync).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("does not create when the subdir already exists", async () => {
    vi.mocked(saf.readDirectoryAsync).mockResolvedValue([
      "content://authority/tree/primary%3Acarnet/document/primary%3Acarnet%2FJournal",
    ]);

    const fs = vaultFsFor(true);
    const uri = await fs.findOrCreateSubdir(
      "content://authority/tree/primary%3Acarnet",
      "Journal",
    );

    expect(saf.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(uri).toBe(
      "content://authority/tree/primary%3Acarnet/document/primary%3Acarnet%2FJournal",
    );
  });

  it("allows a later create for a different name after a prior one settles", async () => {
    vi.mocked(saf.readDirectoryAsync).mockResolvedValue([]);
    vi.mocked(saf.makeDirectoryAsync)
      .mockResolvedValueOnce(
        "content://authority/tree/primary%3Acarnet/document/primary%3Acarnet%2FJournal",
      )
      .mockResolvedValueOnce(
        "content://authority/tree/primary%3Acarnet/document/primary%3Acarnet%2FPeople",
      );

    const fs = vaultFsFor(true);
    await fs.findOrCreateSubdir("content://authority/tree/primary%3Acarnet", "Journal");
    await fs.findOrCreateSubdir("content://authority/tree/primary%3Acarnet", "People");

    expect(saf.makeDirectoryAsync).toHaveBeenCalledTimes(2);
  });
});
