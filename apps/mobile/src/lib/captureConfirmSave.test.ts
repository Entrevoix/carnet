import { beforeEach, describe, expect, it, vi } from "vitest";

const writeIdeaMock = vi.fn();
const appendJournalMock = vi.fn();
const writePersonMock = vi.fn();

vi.mock("./writer", () => ({
  injectAttachments: (markdown: string, refs: unknown[]) =>
    refs.length > 0 ? `${markdown}\n<attachments:${refs.length}>` : markdown,
  writeIdea: (...args: unknown[]) => writeIdeaMock(...args),
  appendJournal: (...args: unknown[]) => appendJournalMock(...args),
  writePerson: (...args: unknown[]) => writePersonMock(...args),
}));

vi.mock("./tags", () => ({
  mergeUserTags: (markdown: string, tags?: string[]) =>
    tags && tags.length > 0 ? `${markdown}\n<tags:${tags.join(",")}>` : markdown,
}));

vi.mock("./frontmatter", () => ({
  upsertFrontmatterField: (markdown: string, field: string, value: string) =>
    `${markdown}\n<${field}:${value}>`,
}));

import { confirmSaveIdea, confirmSaveJournal, confirmSavePerson } from "./captureConfirmSave";
import type { AttachmentRef } from "./writer";

const ref: AttachmentRef = { kind: "image", rel: "../Photos/a.png", filename: "a.png" };

beforeEach(() => {
  writeIdeaMock.mockReset();
  appendJournalMock.mockReset();
  writePersonMock.mockReset();
});

describe("confirmSaveIdea", () => {
  it("composes attachments, tags, and location in order, then writes the idea", async () => {
    writeIdeaMock.mockResolvedValue({ filepath: "file:///v/Ideas/my-idea.md" });

    const result = await confirmSaveIdea({
      slug: "my-idea",
      markdown: "# My Idea\n\nbody",
      refs: [ref],
      tags: ["t1"],
      location: "1,2",
    });

    expect(writeIdeaMock).toHaveBeenCalledWith(
      "my-idea",
      "# My Idea\n\nbody\n<attachments:1>\n<tags:t1>\n<location:1,2>",
    );
    expect(result).toEqual({
      filepath: "file:///v/Ideas/my-idea.md",
      markdown: "# My Idea\n\nbody\n<attachments:1>\n<tags:t1>\n<location:1,2>",
      title: "My Idea",
    });
  });

  // The fixture body deliberately has NO `# ` heading and NO frontmatter. With
  // a heading, deriveTitle returns the same string either way, so the test
  // would pass even if the title were taken from the COMPOSED markdown — the
  // exact regression it is supposed to catch. Headingless, mergeUserTags
  // prepends a `---` frontmatter block, so a post-merge title reads "---".
  it("derives the title from the PRE-merge markdown, not the composed one", async () => {
    writeIdeaMock.mockResolvedValue({ filepath: "file:///v/Ideas/x.md" });
    const result = await confirmSaveIdea({
      slug: "x",
      markdown: "just a plain body line",
      refs: [],
      tags: ["should-not-affect-title"],
      location: null,
    });
    expect(result.title).toBe("just a plain body line");
  });

  it("skips composition steps that have nothing to add", async () => {
    writeIdeaMock.mockResolvedValue({ filepath: "file:///v/Ideas/x.md" });
    await confirmSaveIdea({
      slug: "x",
      markdown: "# X\n\nbody",
      refs: [],
      tags: [],
      location: null,
    });
    expect(writeIdeaMock).toHaveBeenCalledWith("x", "# X\n\nbody");
  });
});

describe("confirmSaveJournal", () => {
  it("composes the entry markdown then returns the day file's accumulated markdown", async () => {
    appendJournalMock.mockResolvedValue({
      filepath: "file:///v/Journal/2026-07-30.md",
      markdown: "<day-file-accumulated>",
    });

    const result = await confirmSaveJournal({
      date: "2026-07-30",
      markdown: "# Journal\n\nentry",
      refs: [ref],
      tags: ["t1"],
      location: "1,2",
    });

    expect(appendJournalMock).toHaveBeenCalledWith(
      "2026-07-30",
      "# Journal\n\nentry\n<attachments:1>\n<tags:t1>\n<location:1,2>",
    );
    // markdown in the result is the day-file's, not the just-composed entry.
    expect(result).toEqual({
      filepath: "file:///v/Journal/2026-07-30.md",
      markdown: "<day-file-accumulated>",
      title: "Journal",
    });
  });
});

describe("confirmSavePerson", () => {
  it("merges tags and location but never injects attachments", async () => {
    writePersonMock.mockResolvedValue({ filepath: "file:///v/People/Jane-Doe.md" });

    const result = await confirmSavePerson({
      firstName: "Jane",
      lastName: "Doe",
      markdown: "# Jane Doe",
      tags: ["contact"],
      location: "1,2",
    });

    expect(writePersonMock).toHaveBeenCalledWith(
      "Jane",
      "Doe",
      "# Jane Doe\n<tags:contact>\n<location:1,2>",
    );
    expect(result.filepath).toBe("file:///v/People/Jane-Doe.md");
    expect(result.title).toBe("Jane Doe");
  });
});
