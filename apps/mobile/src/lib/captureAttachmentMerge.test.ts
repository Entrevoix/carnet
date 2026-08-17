import { describe, expect, it } from "vitest";
import { mergeAttachmentRefs } from "./captureAttachmentMerge";
import type { AttachmentRef } from "./writer";

const img = (rel: string, filename: string): AttachmentRef => ({
  kind: "image",
  rel,
  filename,
});

describe("mergeAttachmentRefs", () => {
  it("returns just the fresh refs on a non-resuming submit, ignoring anything preserved", () => {
    const preserved = [img("../Photos/old.png", "old.png")];
    const refs = [img("../Photos/new.png", "new.png")];
    expect(mergeAttachmentRefs(preserved, refs, false)).toEqual(refs);
  });

  it("concatenates preserved and fresh refs on a resume when they don't overlap", () => {
    const preserved = [img("../Photos/a.png", "a.png")];
    const refs = [img("../Photos/b.png", "b.png")];
    expect(mergeAttachmentRefs(preserved, refs, true)).toEqual([
      img("../Photos/a.png", "a.png"),
      img("../Photos/b.png", "b.png"),
    ]);
  });

  it("de-dupes by rel when the same attachment appears in both lists", () => {
    const shared = img("../Photos/sketch.png", "sketch.png");
    expect(mergeAttachmentRefs([shared], [shared], true)).toEqual([shared]);
  });

  it("keeps the fresh copy's fields when a rel collides (later Map entry wins)", () => {
    const oldOne = img("../Photos/sketch.png", "sketch-renamed.png");
    const freshOne = img("../Photos/sketch.png", "sketch.png");
    expect(mergeAttachmentRefs([oldOne], [freshOne], true)).toEqual([freshOne]);
  });

  it("returns an empty array when nothing was preserved or persisted", () => {
    expect(mergeAttachmentRefs([], [], true)).toEqual([]);
    expect(mergeAttachmentRefs([], [], false)).toEqual([]);
  });
});
