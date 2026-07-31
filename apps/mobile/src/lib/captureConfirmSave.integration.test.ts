import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration-flavored companion to captureConfirmSave.test.ts.
 *
 * That suite stubs `tags` and `frontmatter` with append-only string stubs,
 * which pins COMPOSITION ORDER precisely but cannot pin anything about the
 * resulting bytes — every stub appends, so the first line of the markdown is
 * never affected and a title taken from the composed markdown looks identical
 * to one taken from the pre-merge markdown.
 *
 * Here only the writer is mocked; `mergeUserTags` and `upsertFrontmatterField`
 * are the real implementations. That matters for two reasons:
 *
 *   - Real `mergeUserTags` PREPENDS a `---` frontmatter block to a body that
 *     has none, so it does change the first line. That is what makes the
 *     title-provenance assertions below actually discriminate.
 *   - Frontmatter must stay byte-compatible with the user's Obsidian vault
 *     (CLAUDE.md hard constraint), so asserting real bytes — not stub markers —
 *     is the only assertion that would catch a serialization regression.
 */

const writeIdeaMock = vi.fn();
const appendJournalMock = vi.fn();
const writePersonMock = vi.fn();

// `writer` is mocked whole rather than partially: the real module imports the
// expo file-system chain, which needs the native __DEV__ global. Every case
// here passes `refs: []`, for which the real injectAttachments is a no-op, so
// an identity stub is faithful. The modules under test — `tags` and
// `frontmatter` — are pure and stay REAL.
vi.mock("./writer", () => ({
  injectAttachments: (markdown: string) => markdown,
  writeIdea: (...args: unknown[]) => writeIdeaMock(...args),
  appendJournal: (...args: unknown[]) => appendJournalMock(...args),
  writePerson: (...args: unknown[]) => writePersonMock(...args),
}));

import {
  confirmSaveIdea,
  confirmSaveJournal,
  confirmSavePerson,
} from "./captureConfirmSave";

/** A capture body with no heading and no frontmatter — the shape that makes
 * pre-merge and post-merge titles differ. */
const PLAIN_BODY = "Met Sam at the co-op, follow up re: the grant.";

beforeEach(() => {
  writeIdeaMock.mockReset().mockResolvedValue({ filepath: "file:///v/x.md" });
  appendJournalMock
    .mockReset()
    .mockResolvedValue({ filepath: "file:///v/j.md", markdown: "# Day\n" });
  writePersonMock.mockReset().mockResolvedValue({ filepath: "file:///v/p.md" });
});

describe("title provenance against real tag merging", () => {
  it("confirmSaveIdea titles from the pre-merge body, not the frontmatter block", async () => {
    const result = await confirmSaveIdea({
      slug: "x",
      markdown: PLAIN_BODY,
      refs: [],
      tags: ["grant"],
      location: null,
    });

    // The written markdown really did gain a frontmatter block...
    const written = writeIdeaMock.mock.calls[0][1] as string;
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("grant");
    // ...so a title derived from it would be "---". It must not be.
    expect(result.title).toBe(PLAIN_BODY);
    expect(result.title).not.toBe("---");
  });

  it("confirmSaveJournal titles from the pre-merge entry, not the day file", async () => {
    const result = await confirmSaveJournal({
      date: "2026-07-31",
      markdown: PLAIN_BODY,
      refs: [],
      tags: ["grant"],
      location: null,
    });
    expect(result.title).toBe(PLAIN_BODY);
    expect(result.title).not.toBe("---");
    // The returned markdown is the DAY FILE's accumulated text (used for the
    // note index), not the composed entry fragment.
    expect(result.markdown).toBe("# Day\n");
  });

  it("confirmSavePerson titles from the pre-merge body", async () => {
    const result = await confirmSavePerson({
      firstName: "Sam",
      lastName: "Rivera",
      markdown: PLAIN_BODY,
      tags: ["grant"],
      location: null,
    });
    expect(result.title).toBe(PLAIN_BODY);
    expect(result.title).not.toBe("---");
  });
});

describe("real frontmatter bytes", () => {
  it("merges tags into an existing frontmatter block rather than adding a second one", async () => {
    await confirmSaveIdea({
      slug: "x",
      markdown: "---\nstatus: seedling\n---\n# Heading\n\nbody",
      refs: [],
      tags: ["alpha", "beta"],
      location: null,
    });
    const written = writeIdeaMock.mock.calls[0][1] as string;
    // Exactly one frontmatter delimiter pair opening the document.
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(written).toContain("status: seedling");
    expect(written).toContain("alpha");
    expect(written).toContain("beta");
  });

  it("writes location into the frontmatter, after tags", async () => {
    await confirmSaveIdea({
      slug: "x",
      markdown: "# Heading\n\nbody",
      refs: [],
      tags: ["alpha"],
      location: "48.85,2.35",
    });
    const written = writeIdeaMock.mock.calls[0][1] as string;
    expect(written).toContain("48.85,2.35");
    expect(written.match(/^---$/gm)?.length).toBe(2);
  });

  it("leaves the body untouched when there is nothing to merge", async () => {
    await confirmSaveIdea({
      slug: "x",
      markdown: "# Heading\n\nbody",
      refs: [],
      tags: [],
      location: null,
    });
    expect(writeIdeaMock.mock.calls[0][1]).toBe("# Heading\n\nbody");
  });
});

describe("error propagation out of the lib", () => {
  it("lets a writeIdea rejection escape to the caller", async () => {
    writeIdeaMock.mockRejectedValue(new Error("disk full"));
    await expect(
      confirmSaveIdea({
        slug: "x",
        markdown: "# H",
        refs: [],
        tags: [],
        location: null,
      }),
    ).rejects.toThrow("disk full");
  });

  it("lets an appendJournal rejection escape to the caller", async () => {
    appendJournalMock.mockRejectedValue(new Error("conflict"));
    await expect(
      confirmSaveJournal({
        date: "2026-07-31",
        markdown: "# H",
        refs: [],
        tags: [],
        location: null,
      }),
    ).rejects.toThrow("conflict");
  });

  it("lets a writePerson rejection escape to the caller", async () => {
    writePersonMock.mockRejectedValue(new Error("denied"));
    await expect(
      confirmSavePerson({
        firstName: "Sam",
        lastName: "Rivera",
        markdown: "# H",
        tags: [],
        location: null,
      }),
    ).rejects.toThrow("denied");
  });
});
