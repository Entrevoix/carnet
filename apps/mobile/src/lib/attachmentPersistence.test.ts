import { beforeEach, describe, expect, it, vi } from "vitest";

// writeBinary bumps a collision counter so the second write of the same stem
// lands at `-2`, mirroring findCollisionFreeName's real behavior.
const writeBinaryMock = vi.fn();

vi.mock("./writer", () => ({
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  extFromMime: (mime: string) => (mime === "image/png" ? "png" : "bin"),
  writeBinary: (...args: unknown[]) => writeBinaryMock(...args),
}));

import { persistAttachments } from "./attachmentPersistence";
import type { AttachmentRef } from "./writer";
import type { PickedAttachment } from "./attachments";

function picked(overrides: Partial<PickedAttachment> = {}): PickedAttachment {
  return {
    base64: "AAAA",
    mime: "image/png",
    filename: "sketch.png",
    kind: "image",
    ...overrides,
  } as PickedAttachment;
}

beforeEach(() => {
  writeBinaryMock.mockReset();
});

describe("persistAttachments", () => {
  it("writes each staged attachment once and returns paired rel-path refs", async () => {
    writeBinaryMock.mockImplementation(async (_subdir, name: string) => ({
      filepath: `file:///v/Photos/${name}`,
      finalName: name,
    }));
    const cache = new WeakMap<PickedAttachment, AttachmentRef>();
    const img = picked();
    const file = picked({ mime: "application/pdf", filename: "notes.pdf", kind: "file" });

    const refs = await persistAttachments([img, file], cache);

    expect(writeBinaryMock).toHaveBeenCalledTimes(2);
    expect(refs).toEqual([
      { kind: "image", rel: "../Photos/sketch.png", filename: "sketch.png" },
      { kind: "file", rel: "../Files/notes.bin", filename: "notes.bin" },
    ]);
  });

  it("routes images to Photos and other files to Files", async () => {
    writeBinaryMock.mockImplementation(async (subdir: string, name: string) => ({
      filepath: `file:///v/${subdir}/${name}`,
      finalName: name,
    }));
    const cache = new WeakMap<PickedAttachment, AttachmentRef>();
    await persistAttachments([picked({ kind: "file", mime: "text/plain" })], cache);
    expect(writeBinaryMock).toHaveBeenCalledWith("Files", "sketch.bin", "AAAA", "text/plain");
  });

  it("falls back to 'attachment' when the filename slugifies to nothing", async () => {
    writeBinaryMock.mockImplementation(async (_subdir, name: string) => ({
      filepath: `file:///v/Photos/${name}`,
      finalName: name,
    }));
    const cache = new WeakMap<PickedAttachment, AttachmentRef>();
    const refs = await persistAttachments([picked({ filename: "📷.png" })], cache);
    expect(refs[0].filename).toBe("attachment.png");
  });

  it("dedups on a retry via the cache — no second write, no orphan", async () => {
    let counter = 0;
    writeBinaryMock.mockImplementation(async (_subdir, name: string) => {
      counter += 1;
      const finalName = counter === 1 ? name : name.replace(/\.png$/, "-2.png");
      return { filepath: `file:///v/Photos/${finalName}`, finalName };
    });
    const cache = new WeakMap<PickedAttachment, AttachmentRef>();
    const img = picked();

    const first = await persistAttachments([img], cache);
    const second = await persistAttachments([img], cache);

    // Same object → written once, both calls return the identical ref.
    expect(writeBinaryMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second[0].filename).toBe("sketch.png");
  });

  it("writes a newly-added attachment even when a prior one is cached", async () => {
    writeBinaryMock.mockImplementation(async (_subdir, name: string) => ({
      filepath: `file:///v/Photos/${name}`,
      finalName: name,
    }));
    const cache = new WeakMap<PickedAttachment, AttachmentRef>();
    const first = picked();
    await persistAttachments([first], cache);
    const second = picked({ filename: "map.png" });
    const refs = await persistAttachments([first, second], cache);

    // first served from cache, second freshly written.
    expect(writeBinaryMock).toHaveBeenCalledTimes(2);
    expect(refs.map((r) => r.filename)).toEqual(["sketch.png", "map.png"]);
  });
});
