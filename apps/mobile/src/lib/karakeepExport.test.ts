// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the writer (vault resolution) and the karakeep network client so the
// orchestration logic — which links get uploaded, in what order, and how a
// failure short-circuits — is tested in isolation.
vi.mock("./writer", () => ({
  listPairedBinaries: vi.fn(),
  resolvePairedUri: vi.fn(),
}));
vi.mock("./karakeep", () => ({
  uploadAsset: vi.fn(),
  attachAssetToBookmark: vi.fn(),
}));
// Mock the sync-record store so the orchestration logic — which links get
// uploaded, in what order, what gets recorded, how failures short-circuit — is
// tested in isolation. assetKey stays the real (pure) join.
vi.mock("./karakeepAssetSync", () => ({
  assetKey: (subdir: string, filename: string) => `${subdir}/${filename}`,
  loadPushedAssetKeys: vi.fn(),
  savePushedAssetKeys: vi.fn(),
}));

import { pushNoteAttachments } from "./karakeepExport";
import { listPairedBinaries, resolvePairedUri } from "./writer";
import { uploadAsset, attachAssetToBookmark } from "./karakeep";
import { loadPushedAssetKeys, savePushedAssetKeys } from "./karakeepAssetSync";

const mockList = vi.mocked(listPairedBinaries);
const mockResolve = vi.mocked(resolvePairedUri);
const mockUpload = vi.mocked(uploadAsset);
const mockAttach = vi.mocked(attachAssetToBookmark);
const mockLoadPushed = vi.mocked(loadPushedAssetKeys);
const mockSavePushed = vi.mocked(savePushedAssetKeys);

function link(subdir: "Photos" | "Files" | "Audio", filename: string) {
  return { subdir, filename, rel: `../${subdir}/${filename}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy resolutions/uploads; per-test overrides where needed.
  mockResolve.mockImplementation(async (subdir: string, filename: string) => ({
    uri: `file:///vault/${subdir}/${filename}`,
    mime: filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
  }));
  let n = 0;
  mockUpload.mockImplementation(async () => ({ assetId: `as_${++n}` }));
  mockAttach.mockResolvedValue(undefined);
  // Default: nothing synced yet for this bookmark.
  mockLoadPushed.mockResolvedValue(new Set());
  mockSavePushed.mockResolvedValue(undefined);
});

describe("pushNoteAttachments", () => {
  it("uploads and attaches each non-Audio attachment, returns null", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockUpload).toHaveBeenNthCalledWith(1, {
      uri: "file:///vault/Photos/a.jpg",
      mime: "image/jpeg",
      filename: "a.jpg",
    });
    expect(mockAttach).toHaveBeenNthCalledWith(1, "bk_1", "as_1");
    expect(mockAttach).toHaveBeenNthCalledWith(2, "bk_1", "as_2");
  });

  it("skips Audio links entirely (never resolves or uploads them)", async () => {
    mockList.mockReturnValue([link("Audio", "voice.m4a"), link("Photos", "a.jpg")]);

    await pushNoteAttachments("bk_1", "body");

    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockResolve).toHaveBeenCalledWith("Photos", "a.jpg");
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it("skips broken links (resolve returns null) without uploading", async () => {
    mockList.mockReturnValue([link("Photos", "gone.jpg"), link("Files", "ok.pdf")]);
    mockResolve.mockImplementation(async (subdir: string, filename: string) =>
      filename === "gone.jpg"
        ? null
        : { uri: `file:///vault/${subdir}/${filename}`, mime: "application/pdf" },
    );

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith({
      uri: "file:///vault/Files/ok.pdf",
      mime: "application/pdf",
      filename: "ok.pdf",
    });
  });

  it("returns the error message and stops at the first failed upload", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockUpload.mockRejectedValueOnce(new Error("Karakeep error — HTTP 413"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBe("Karakeep error — HTTP 413");
    expect(mockUpload).toHaveBeenCalledOnce(); // did not attempt the second
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("returns the error when an attach fails (after a successful upload)", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockAttach.mockRejectedValueOnce(new Error("attach failed"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBe("attach failed");
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it("returns null and makes no network calls when there are no attachments", async () => {
    mockList.mockReturnValue([]);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAttach).not.toHaveBeenCalled();
  });

  // ── Incremental sync ────────────────────────────────────────────────────────

  it("loads the pushed-key set for the bookmark being exported", async () => {
    mockList.mockReturnValue([]);

    await pushNoteAttachments("bk_42", "body");

    expect(mockLoadPushed).toHaveBeenCalledWith("bk_42");
  });

  it("skips attachments already attached to this bookmark", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);
    mockLoadPushed.mockResolvedValue(new Set(["Photos/a.jpg"]));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith({
      uri: "file:///vault/Files/b.pdf",
      mime: "application/pdf",
      filename: "b.pdf",
    });
    expect(mockAttach).toHaveBeenCalledOnce();
    expect(mockAttach).toHaveBeenCalledWith("bk_1", "as_1");
  });

  it("records nothing and uploads nothing when every attachment is already synced", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);
    mockLoadPushed.mockResolvedValue(new Set(["Photos/a.jpg", "Files/b.pdf"]));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSavePushed).not.toHaveBeenCalled();
  });

  it("records each attachment key after its successful attach (cumulative)", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);

    await pushNoteAttachments("bk_1", "body");

    expect(mockSavePushed).toHaveBeenCalledTimes(2);
    expect(mockSavePushed).toHaveBeenNthCalledWith(1, "bk_1", ["Photos/a.jpg"]);
    expect(mockSavePushed).toHaveBeenNthCalledWith(2, "bk_1", [
      "Photos/a.jpg",
      "Files/b.pdf",
    ]);
  });

  it("persists the success before a later failure and leaves the failed key unrecorded", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockUpload
      .mockImplementationOnce(async () => ({ assetId: "as_1" }))
      .mockRejectedValueOnce(new Error("Karakeep error — HTTP 500"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBe("Karakeep error — HTTP 500");
    // a.jpg attached → persisted once; b.jpg failed at upload → not persisted.
    expect(mockSavePushed).toHaveBeenCalledOnce();
    expect(mockSavePushed).toHaveBeenCalledWith("bk_1", ["Photos/a.jpg"]);
  });

  it("does not record a broken link, so it retries on a later export", async () => {
    mockList.mockReturnValue([link("Photos", "gone.jpg")]);
    mockResolve.mockResolvedValue(null);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSavePushed).not.toHaveBeenCalled();
  });
});
