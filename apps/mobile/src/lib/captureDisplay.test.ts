import { describe, expect, it } from "vitest";
import {
  buildPreviewSubtitle,
  buildMetaSummary,
  buildCapturePreviewResponse,
} from "./captureDisplay";
import type { PickedAttachment } from "./attachments";

describe("buildPreviewSubtitle", () => {
  it("builds the Ideas filename + model for idea mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "idea",
        pendingIdea: { slug: "my-idea" },
        pendingJournal: null,
        pendingPerson: null,
        omniModel: "gpt-4",
      }),
    ).toBe("Ideas/my-idea.md • gpt-4");
  });

  it("builds the Journal filename for journal mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "journal",
        pendingIdea: null,
        pendingJournal: { date: "2026-07-30" },
        pendingPerson: null,
        omniModel: null,
      }),
    ).toBe("Journal/2026-07-30.md");
  });

  it("builds the People filename for person mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "person",
        pendingIdea: null,
        pendingJournal: null,
        pendingPerson: { firstName: "Jane", lastName: "Doe" },
        omniModel: "claude",
      }),
    ).toBe("People/Jane-Doe.md • claude");
  });

  it("returns an empty-filename subtitle when the mode's pending object isn't set yet", () => {
    expect(
      buildPreviewSubtitle({
        mode: "idea",
        pendingIdea: null,
        pendingJournal: null,
        pendingPerson: null,
        omniModel: null,
      }),
    ).toBe("");
  });
});

function picked(overrides: Partial<PickedAttachment> = {}): PickedAttachment {
  return {
    base64: "AAAA",
    mime: "image/png",
    filename: "sketch.png",
    kind: "image",
    ...overrides,
  } as PickedAttachment;
}

describe("buildMetaSummary", () => {
  it("returns an empty string when nothing is staged", () => {
    expect(buildMetaSummary([], [], null)).toBe("");
  });

  it("pluralizes tag/attachment counts and joins with a middle dot", () => {
    expect(buildMetaSummary(["a", "b"], [picked(), picked()], "1,2")).toBe(
      "2 tags · 2 attachments · location",
    );
  });

  it("keeps singular wording at count 1", () => {
    expect(buildMetaSummary(["a"], [picked()], null)).toBe("1 tag · 1 attachment");
  });
});

describe("buildCapturePreviewResponse", () => {
  it("builds an ok-status response without a filepath by default", () => {
    expect(buildCapturePreviewResponse("# Hi")).toEqual({
      type: "capture_response",
      request_id: "",
      status: "ok",
      preview_markdown: "# Hi",
      filepath: undefined,
    });
  });

  it("includes the filepath when provided (promote after a saved note)", () => {
    expect(buildCapturePreviewResponse("# Hi", "file:///v/Ideas/hi.md")).toEqual({
      type: "capture_response",
      request_id: "",
      status: "ok",
      preview_markdown: "# Hi",
      filepath: "file:///v/Ideas/hi.md",
    });
  });
});
