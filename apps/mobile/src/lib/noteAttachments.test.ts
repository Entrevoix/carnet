import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the two writer helpers this module uses — the rest of writer.ts pulls
// expo-file-system, which has no business in a pure resolution test.
vi.mock("./writer", () => ({
  listPairedBinaries: vi.fn(),
  resolvePairedUri: vi.fn(),
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

import * as Sharing from "expo-sharing";

import { imageUrisByRel, openAttachment, resolveNoteAttachments } from "./noteAttachments";
import { listPairedBinaries, resolvePairedUri } from "./writer";

type Link = { subdir: string; filename: string; rel: string };

function link(subdir: string, filename: string): Link {
  return { subdir, filename, rel: `../${subdir}/${filename}` };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveNoteAttachments", () => {
  it("resolves each non-Audio paired link to a storage URI", async () => {
    vi.mocked(listPairedBinaries).mockReturnValue([
      link("Photos", "a.jpg"),
      link("Files", "spec.pdf"),
    ] as unknown as ReturnType<typeof listPairedBinaries>);
    vi.mocked(resolvePairedUri).mockImplementation(async (subdir, filename) => ({
      uri: `file:///v/${String(subdir)}/${String(filename)}`,
      mime: filename === "a.jpg" ? "image/jpeg" : "application/pdf",
    }));

    await expect(resolveNoteAttachments("body")).resolves.toEqual([
      {
        rel: "../Photos/a.jpg",
        filename: "a.jpg",
        uri: "file:///v/Photos/a.jpg",
        mime: "image/jpeg",
      },
      {
        rel: "../Files/spec.pdf",
        filename: "spec.pdf",
        uri: "file:///v/Files/spec.pdf",
        mime: "application/pdf",
      },
    ]);
  });

  it("excludes Audio links — the dedicated player renders those", async () => {
    vi.mocked(listPairedBinaries).mockReturnValue([
      link("Audio", "voice.m4a"),
      link("Photos", "a.jpg"),
    ] as unknown as ReturnType<typeof listPairedBinaries>);
    vi.mocked(resolvePairedUri).mockResolvedValue({
      uri: "file:///v/Photos/a.jpg",
      mime: "image/jpeg",
    });

    const out = await resolveNoteAttachments("body");

    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe("a.jpg");
    expect(vi.mocked(resolvePairedUri)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolvePairedUri)).toHaveBeenCalledWith("Photos", "a.jpg");
  });

  it("drops links that fail to resolve instead of failing the whole set", async () => {
    vi.mocked(listPairedBinaries).mockReturnValue([
      link("Photos", "gone.jpg"),
      link("Photos", "here.jpg"),
    ] as unknown as ReturnType<typeof listPairedBinaries>);
    vi.mocked(resolvePairedUri).mockImplementation(async (_subdir, filename) =>
      filename === "gone.jpg"
        ? null
        : { uri: "file:///v/Photos/here.jpg", mime: "image/jpeg" },
    );

    const out = await resolveNoteAttachments("body");

    expect(out.map((a) => a.filename)).toEqual(["here.jpg"]);
  });
});

describe("imageUrisByRel", () => {
  it("maps image embeds by their relative link and omits non-images", () => {
    const map = imageUrisByRel([
      { rel: "../Photos/a.jpg", filename: "a.jpg", uri: "u1", mime: "image/jpeg" },
      { rel: "../Files/s.pdf", filename: "s.pdf", uri: "u2", mime: "application/pdf" },
    ]);

    expect(map.get("../Photos/a.jpg")).toBe("u1");
    expect(map.has("../Files/s.pdf")).toBe(false);
  });
});

describe("openAttachment", () => {
  it("shares the uri when sharing is available", async () => {
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);

    await openAttachment("file:///v/Files/s.pdf");

    expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalledWith("file:///v/Files/s.pdf");
  });

  it("no-ops when sharing is unavailable", async () => {
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);

    await openAttachment("file:///v/Files/s.pdf");

    expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
  });

  it("swallows a share failure rather than rejecting into the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
    vi.mocked(Sharing.shareAsync).mockRejectedValue(new Error("no handler"));

    await expect(openAttachment("content://x")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
