// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", () => ({ updateNote: vi.fn(async () => {}) }));
vi.mock("./dispatcher", () => ({
  enhanceProse: vi.fn(),
  FALLBACK_PROVIDER_FIELD: "fallback",
}));

import {
  enhanceNoteProse,
  extractAttachmentLines,
  splitLeadingTitle,
  ENHANCED_FIELD,
} from "./enhanceProse";
import { updateNote } from "./writer";
import { enhanceProse as dispatchEnhance } from "./dispatcher";

const mockUpdateNote = vi.mocked(updateNote);
const mockDispatch = vi.mocked(dispatchEnhance);

/** A dispatcher result with no fallback — the ordinary path. */
function ok(markdown: string, providerLabel = "OpenAI") {
  return { result: { markdown, model: "gpt-5" }, usedFallback: false, fallbackProviderId: null, providerLabel };
}

const LONG_PROSE = "went out early. it was cold. saw the heron again by the bridge.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("splitLeadingTitle", () => {
  it("splits a leading H1 (with its trailing blank lines) off the prose", () => {
    expect(splitLeadingTitle("# Morning walk\n\nwent out early.")).toEqual({
      title: "# Morning walk\n\n",
      prose: "went out early.",
    });
  });

  it("returns an empty title when there is no leading H1", () => {
    expect(splitLeadingTitle("just prose, no heading")).toEqual({
      title: "",
      prose: "just prose, no heading",
    });
  });

  it("does NOT treat a '##' section heading as the title", () => {
    // Deeper headings belong to the prose and must reach the model with it.
    const body = "## Notes\n\n- a thing";
    expect(splitLeadingTitle(body)).toEqual({ title: "", prose: body });
  });
});

describe("extractAttachmentLines", () => {
  it("pulls out image, audio and file links, keeping their order", () => {
    const { attachments, rest } = extractAttachmentLines(
      "![](../Photos/a.jpg)\nsome prose\n[rec](../Audio/b.m4a)\n[doc](../Files/c.pdf)\nmore",
    );
    expect(attachments).toEqual([
      "![](../Photos/a.jpg)",
      "[rec](../Audio/b.m4a)",
      "[doc](../Files/c.pdf)",
    ]);
    expect(rest).toBe("some prose\nmore");
  });

  it("leaves prose without attachments untouched", () => {
    const prose = "## Notes\n\n- just words\n";
    expect(extractAttachmentLines(prose)).toEqual({ attachments: [], rest: prose });
  });

  it("does not strip an inline link that merely mentions a path", () => {
    // Only a line that is SOLELY a paired link counts — prose that happens to
    // contain one keeps it, matching writer.ts's stripPairedBinaryLinks.
    const prose = "I saved it at ../Photos/a.jpg yesterday";
    expect(extractAttachmentLines(prose).attachments).toEqual([]);
  });
});

describe("enhanceNoteProse", () => {
  it("never sends a paired-binary link to the model, and restores it after", async () => {
    // Regression guard for a defect found on-device 2026-08-05: every
    // photo-bearing journal entry has the embed sitting in the body, and a
    // model told to return only prose drops it — orphaning the .jpg on disk.
    // Shaped on the real vault note Journal/2026-08-05.md.
    mockDispatch.mockResolvedValue(ok("I went to France, by way of Stroudsburg."));
    const input =
      "---\ndate: 2026-08-05\ntags: [journal, family, travel]\n---\n" +
      "# My family traveled to France via Stroudsburg\n\n" +
      "![](../Photos/pxl-20260805-125007007.jpg)\n\n" +
      "## Notes\n\n- Family went to France with a brief stop in Stroudsburg.\n";

    const outcome = await enhanceNoteProse({ body: input, filepath: "f.md" });

    expect(mockDispatch.mock.calls[0][0]).not.toContain("../Photos/");
    expect(outcome.kind).toBe("updated");
    const written = mockUpdateNote.mock.calls[0][1];
    expect(written).toContain("![](../Photos/pxl-20260805-125007007.jpg)");
    // Exactly once — restored, not duplicated.
    expect(written.match(/pxl-20260805-125007007\.jpg/g)).toHaveLength(1);
    // And it sits under the title, above the enhanced prose.
    expect(written.indexOf("../Photos/")).toBeLessThan(written.indexOf("I went to France"));
  });

  it("restores multiple attachments of mixed kinds", async () => {
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard"));
    const input =
      `# T\n\n![](../Photos/a.jpg)\n\n${LONG_PROSE}\n\n[rec](../Audio/b.m4a)\n`;

    await enhanceNoteProse({ body: input, filepath: "f.md" });

    const written = mockUpdateNote.mock.calls[0][1];
    expect(written).toContain("![](../Photos/a.jpg)");
    expect(written).toContain("[rec](../Audio/b.m4a)");
  });

  it("refuses an attachment-only note instead of enhancing an empty body", async () => {
    // Stripping the embed leaves nothing worth a model call — and a near-empty
    // body is the case most likely to make a model invent content.
    const outcome = await enhanceNoteProse({
      body: "# T\n\n![](../Photos/a.jpg)\n",
      filepath: "f.md",
    });

    expect(outcome.kind).toBe("failed");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("replaces the prose while preserving frontmatter and title byte-for-byte", async () => {
    mockDispatch.mockResolvedValue(ok("I went out early, before the cold had lifted."));
    const input = `---\ndate: 2026-08-05\ntags: [journal, walk]\n---\n# Morning walk\n\n${LONG_PROSE}\n`;

    const outcome = await enhanceNoteProse({ body: input, filepath: "f.md" });

    expect(outcome.kind).toBe("updated");
    const written = mockUpdateNote.mock.calls[0][1];
    // The frontmatter block and the H1 survive untouched...
    expect(written).toContain("date: 2026-08-05");
    expect(written).toContain("tags: [journal, walk]");
    expect(written).toContain("# Morning walk");
    // ...the old prose is gone, the new prose is in.
    expect(written).not.toContain("went out early. it was cold.");
    expect(written).toContain("I went out early, before the cold had lifted.");
    // Only the prose was ever sent to the model.
    expect(mockDispatch).toHaveBeenCalledWith(`${LONG_PROSE}\n`);
  });

  it("sends neither frontmatter nor the title to the model", async () => {
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard"));
    const input = `---\nsecret: value\n---\n# A Title\n\n${LONG_PROSE}\n`;

    await enhanceNoteProse({ body: input, filepath: "f.md" });

    const sent = mockDispatch.mock.calls[0][0];
    expect(sent).not.toContain("secret: value");
    expect(sent).not.toContain("# A Title");
    expect(sent).not.toContain("---");
  });

  it("stamps the enhanced date on a note that has frontmatter", async () => {
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard"));
    const input = `---\ndate: 2026-08-05\n---\n# T\n\n${LONG_PROSE}\n`;

    await enhanceNoteProse({ body: input, filepath: "f.md" });

    expect(mockUpdateNote.mock.calls[0][1]).toMatch(
      new RegExp(`^---[\\s\\S]*${ENHANCED_FIELD}: \\d{4}-\\d{2}-\\d{2}[\\s\\S]*---`),
    );
  });

  it("does NOT grow a frontmatter block onto a note that never had one", async () => {
    // upsertFrontmatterField CREATES a block when absent; stamping such a note
    // would be a structural change to a file this feature only rewords.
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard"));

    await enhanceNoteProse({ body: `# T\n\n${LONG_PROSE}\n`, filepath: "f.md" });

    const written = mockUpdateNote.mock.calls[0][1];
    expect(written.startsWith("---")).toBe(false);
    expect(written).not.toContain(ENHANCED_FIELD);
    expect(written).toContain("# T");
  });

  it("stamps the fallback provider only when the fallback actually served the call", async () => {
    mockDispatch.mockResolvedValue({
      result: { markdown: "polished enough prose to pass the guard", model: "m" },
      usedFallback: true,
      fallbackProviderId: "relais",
      providerLabel: "OpenAI",
    });

    await enhanceNoteProse({
      body: `---\ndate: 2026-08-05\n---\n# T\n\n${LONG_PROSE}\n`,
      filepath: "f.md",
    });

    expect(mockUpdateNote.mock.calls[0][1]).toContain("fallback: relais");
  });

  it("returns the provider label for the success snackbar", async () => {
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard", "Groq"));

    const outcome = await enhanceNoteProse({
      body: `# T\n\n${LONG_PROSE}\n`,
      filepath: "f.md",
    });

    expect(outcome).toMatchObject({ kind: "updated", providerLabel: "Groq" });
  });

  it("refuses a too-short note without calling the model or writing", async () => {
    const outcome = await enhanceNoteProse({ body: "# T\n\nok.\n", filepath: "f.md" });

    expect(outcome.kind).toBe("failed");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("treats a frontmatter-only note as too short", async () => {
    const outcome = await enhanceNoteProse({
      body: "---\ndate: 2026-08-05\n---\n",
      filepath: "f.md",
    });

    expect(outcome.kind).toBe("failed");
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("leaves the note untouched when the model returns nothing", async () => {
    mockDispatch.mockResolvedValue(ok("   \n  "));

    const outcome = await enhanceNoteProse({
      body: `# T\n\n${LONG_PROSE}\n`,
      filepath: "f.md",
    });

    expect(outcome.kind).toBe("failed");
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("surfaces a dispatcher failure as a reason and writes nothing", async () => {
    mockDispatch.mockRejectedValue(new Error("OpenAI is unreachable"));

    const outcome = await enhanceNoteProse({
      body: `# T\n\n${LONG_PROSE}\n`,
      filepath: "f.md",
    });

    expect(outcome).toEqual({ kind: "failed", reason: "OpenAI is unreachable" });
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("surfaces a write failure rather than reporting success", async () => {
    mockDispatch.mockResolvedValue(ok("polished enough prose to pass the guard"));
    mockUpdateNote.mockRejectedValueOnce(new Error("disk full"));

    const outcome = await enhanceNoteProse({
      body: `# T\n\n${LONG_PROSE}\n`,
      filepath: "f.md",
    });

    expect(outcome).toEqual({ kind: "failed", reason: "disk full" });
  });

  it("trims surrounding blank lines and ends the note with exactly one newline", async () => {
    mockDispatch.mockResolvedValue(ok("\n\npolished enough prose to pass the guard\n\n"));

    await enhanceNoteProse({ body: `# T\n\n${LONG_PROSE}\n`, filepath: "f.md" });

    const written = mockUpdateNote.mock.calls[0][1];
    expect(written).toBe("# T\n\npolished enough prose to pass the guard\n");
  });
});
