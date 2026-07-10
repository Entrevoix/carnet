import { beforeEach, describe, expect, it, vi } from "vitest";

const getModificationTimeMock = vi.fn();
const readNoteMock = vi.fn();
const rewriteFrontmatterFieldMock = vi.fn();
const updateNoteIfUnchangedMock = vi.fn();

vi.mock("./writer", () => ({
  getModificationTime: (...args: unknown[]) => getModificationTimeMock(...args),
  readNote: (...args: unknown[]) => readNoteMock(...args),
  rewriteFrontmatterField: (...args: unknown[]) => rewriteFrontmatterFieldMock(...args),
  updateNoteIfUnchanged: (...args: unknown[]) => updateNoteIfUnchangedMock(...args),
}));

import { promoteIdeaOnDisk } from "./promoteIdeaOnDisk";

beforeEach(() => {
  getModificationTimeMock.mockReset().mockResolvedValue(42);
  readNoteMock.mockReset();
  rewriteFrontmatterFieldMock
    .mockReset()
    .mockImplementation((md: string, _f: string, v: string) => `${md}\n<status:${v}>`);
  updateNoteIfUnchangedMock.mockReset().mockResolvedValue({ ok: true });
});

describe("promoteIdeaOnDisk", () => {
  it("surgically rewrites the current file's status, guarded by its mtime", async () => {
    readNoteMock.mockResolvedValue("---\nstatus: seedling\n---\n# Idea\n");

    const result = await promoteIdeaOnDisk("file:///v/Ideas/x.md", "developing", "# Enriched\n");

    expect(rewriteFrontmatterFieldMock).toHaveBeenCalledWith(
      "---\nstatus: seedling\n---\n# Idea\n",
      "status",
      "developing",
    );
    // The rewritten (not the enriched) markdown is written, guarded by baseline mtime.
    expect(updateNoteIfUnchangedMock).toHaveBeenCalledWith(
      "file:///v/Ideas/x.md",
      "---\nstatus: seedling\n---\n# Idea\n\n<status:developing>",
      42,
    );
    expect(result).toEqual({ conflict: false });
  });

  it("reports a conflict (write skipped) when the file changed under it", async () => {
    readNoteMock.mockResolvedValue("# whatever\n");
    updateNoteIfUnchangedMock.mockResolvedValue({ ok: false, reason: "conflict" });

    const result = await promoteIdeaOnDisk("file:///v/Ideas/x.md", "developing", "# Enriched\n");
    expect(result).toEqual({ conflict: true });
  });

  it("falls back to the enriched markdown when the note can't be read", async () => {
    readNoteMock.mockRejectedValue(new Error("gone"));

    const result = await promoteIdeaOnDisk("file:///v/Ideas/x.md", "developing", "# Enriched\n");

    expect(rewriteFrontmatterFieldMock).not.toHaveBeenCalled();
    expect(updateNoteIfUnchangedMock).toHaveBeenCalledWith(
      "file:///v/Ideas/x.md",
      "# Enriched\n",
      42,
    );
    expect(result).toEqual({ conflict: false });
  });

  it("reports a conflict on the fallback path too", async () => {
    readNoteMock.mockRejectedValue(new Error("gone"));
    updateNoteIfUnchangedMock.mockResolvedValue({ ok: false, reason: "conflict" });

    const result = await promoteIdeaOnDisk("file:///v/Ideas/x.md", "developing", "# Enriched\n");
    expect(result).toEqual({ conflict: true });
  });
});
