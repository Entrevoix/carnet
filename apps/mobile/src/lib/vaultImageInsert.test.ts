// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./attachments", () => ({ pickAttachment: vi.fn() }));
vi.mock("./writer", () => ({
  extFromMime: vi.fn(() => "jpg"),
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  writeBinary: vi.fn(),
}));
vi.mock("./editorImages", () => ({
  MAX_EDITOR_IMAGE_BASE64: 100,
  toDataUri: vi.fn((mime: string, b64: string) => `data:${mime};base64,${b64}`),
}));

import { pickAndWriteVaultImage } from "./vaultImageInsert";
import { pickAttachment } from "./attachments";
import { writeBinary } from "./writer";

const mockPick = vi.mocked(pickAttachment);
const mockWrite = vi.mocked(writeBinary);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pickAndWriteVaultImage", () => {
  it("returns null when the user cancels the picker (nothing written)", async () => {
    mockPick.mockResolvedValue(null);
    expect(await pickAndWriteVaultImage()).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes the image to Photos/ and returns the rel + a preview data URI under the cap", async () => {
    mockPick.mockResolvedValue({
      base64: "AB",
      mime: "image/jpeg",
      filename: "My Photo.jpeg",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "my-photo.jpg" });
    const out = await pickAndWriteVaultImage();
    expect(mockWrite).toHaveBeenCalledWith("Photos", "my-photo.jpg", "AB", "image/jpeg");
    expect(out).toEqual({
      rel: "../Photos/my-photo.jpg",
      dataUri: "data:image/jpeg;base64,AB",
    });
  });

  it("returns a null data URI when the image is over the inline cap", async () => {
    mockPick.mockResolvedValue({
      base64: "X".repeat(200), // over MAX_EDITOR_IMAGE_BASE64 (100)
      mime: "image/png",
      filename: "big.png",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "big.png" });
    const out = await pickAndWriteVaultImage();
    expect(out?.rel).toBe("../Photos/big.png");
    expect(out?.dataUri).toBeNull();
  });

  it("falls back to 'image' as the slug base when the name slugifies to nothing", async () => {
    mockPick.mockResolvedValue({
      base64: "AB",
      mime: "image/jpeg",
      filename: ".jpeg",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "image.jpg" });
    await pickAndWriteVaultImage();
    expect(mockWrite).toHaveBeenCalledWith("Photos", "image.jpg", "AB", "image/jpeg");
  });
});
