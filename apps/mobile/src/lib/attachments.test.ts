import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// expo-document-picker is a native module; shareHelpers pulls in
// expo-file-system. Both are replaced so the pick → read → classify → cap
// logic can be exercised in Node. The size caps are shrunk to tiny values so a
// short string can trip them without allocating hundreds of MB.

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock("./shareHelpers", () => ({
  readShareFileAsBase64: vi.fn(),
  sanitizeShareString: (v: string) => v.replace(/[\r\n]/g, " "),
  MAX_SAFE_SHARE_BYTES: 100,
  BASE64_EXPANSION: 1.4,
}));

import { pickAttachment } from "./attachments";
import { getDocumentAsync } from "expo-document-picker";
import { readShareFileAsBase64 } from "./shareHelpers";

/** Build a non-cancelled picker result with a single asset. */
function picked(asset: {
  uri?: string;
  name?: string;
  size?: number;
  mimeType?: string;
}) {
  return {
    canceled: false as const,
    assets: [{ uri: "file:///cache/x", name: "x", lastModified: 0, ...asset }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pickAttachment", () => {
  it("classifies an image MIME as kind 'image'", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue(
      picked({ uri: "file:///cache/a.jpg", name: "a.jpg", size: 10, mimeType: "image/jpeg" }),
    );
    vi.mocked(readShareFileAsBase64).mockResolvedValue("QUJD");

    const result = await pickAttachment();
    expect(result).toEqual({
      base64: "QUJD",
      mime: "image/jpeg",
      filename: "a.jpg",
      kind: "image",
    });
  });

  it("classifies a non-image MIME as kind 'file'", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue(
      picked({ name: "spec.pdf", size: 10, mimeType: "application/pdf" }),
    );
    vi.mocked(readShareFileAsBase64).mockResolvedValue("UERG");

    const result = await pickAttachment();
    expect(result?.kind).toBe("file");
    expect(result?.mime).toBe("application/pdf");
    expect(result?.filename).toBe("spec.pdf");
  });

  it("defaults a missing MIME to octet-stream (and kind 'file')", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue(picked({ name: "raw", size: 1 }));
    vi.mocked(readShareFileAsBase64).mockResolvedValue("QQ==");

    const result = await pickAttachment();
    expect(result?.mime).toBe("application/octet-stream");
    expect(result?.kind).toBe("file");
  });

  it("passes type image/* when imagesOnly is set", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue(
      picked({ name: "a.png", size: 1, mimeType: "image/png" }),
    );
    vi.mocked(readShareFileAsBase64).mockResolvedValue("AAAA");

    await pickAttachment({ imagesOnly: true });
    expect(vi.mocked(getDocumentAsync)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/*", copyToCacheDirectory: true }),
    );
  });

  it("returns null when the user cancels", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    expect(await pickAttachment()).toBeNull();
    expect(vi.mocked(readShareFileAsBase64)).not.toHaveBeenCalled();
  });

  it("returns null when the picker yields no asset", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue({ canceled: false, assets: [] });
    expect(await pickAttachment()).toBeNull();
  });

  it("throws on a known size over the cap WITHOUT reading the file", async () => {
    vi.mocked(getDocumentAsync).mockResolvedValue(
      picked({ name: "big.bin", size: 200, mimeType: "application/octet-stream" }),
    );
    await expect(pickAttachment()).rejects.toThrow(/capped at/);
    expect(vi.mocked(readShareFileAsBase64)).not.toHaveBeenCalled();
  });

  it("throws after reading when size was unknown but the bytes exceed the cap", async () => {
    // No `size` from the provider → pre-check skipped; the post-read length
    // check (base64 length vs cap × expansion) catches it.
    vi.mocked(getDocumentAsync).mockResolvedValue(
      picked({ name: "mystery", mimeType: "image/png" }),
    );
    vi.mocked(readShareFileAsBase64).mockResolvedValue("A".repeat(200));
    await expect(pickAttachment()).rejects.toThrow(/capped at/);
  });
});
