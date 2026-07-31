// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the IO surface is mocked. The pure collaborators — markdownEdit,
// wysiwygSave/tags, frontmatter, @carnet/shared's deriveTitle — run for real,
// so the assertions below pin actual bytes rather than stub echoes.
vi.mock("./writer", async () => {
  const fm = await import("./frontmatter");
  return {
    splitFrontmatter: fm.splitFrontmatter,
    updateNote: vi.fn(async () => undefined),
  };
});
vi.mock("./storage", () => ({ updateCaptureTitle: vi.fn(async () => undefined) }));
vi.mock("./vault", async () => {
  const fm = await import("./frontmatter");
  return {
    getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
    invalidateNoteIndex: vi.fn(async () => undefined),
    tagsForNote: (md: string) => fm.getFrontmatterTags(md),
  };
});
vi.mock("./vaultImageInsert", () => ({ pickAndWriteVaultImage: vi.fn() }));

import { updateCaptureTitle } from "./storage";
import { getTagIndex, invalidateNoteIndex } from "./vault";
import { pickAndWriteVaultImage } from "./vaultImageInsert";
import { updateNote } from "./writer";
import { useNoteEditSession, type NoteEditSession } from "./useNoteEditSession";

const HEADER = "---\ncreated: 2026-07-08T11:55:46.000Z\ntags: [qa-test]\n---\n";
const NOTE_BODY = "# Draft Survival Test\n\nHello body text.\n";
const NOTE = HEADER + NOTE_BODY;

function setup(overrides: Partial<Parameters<typeof useNoteEditSession>[0]> = {}) {
  const onBodyChange = vi.fn();
  const hook = renderHook(
    (props: Partial<Parameters<typeof useNoteEditSession>[0]>) =>
      useNoteEditSession({
        body: NOTE,
        filepath: "file:///v/Ideas/draft-survival-test.md",
        entryId: "r1",
        entryTitle: "Draft Survival Test",
        richEditorEnabled: false,
        onBodyChange,
        ...props,
      }),
    { initialProps: overrides },
  );
  return { ...hook, onBodyChange };
}

/** Install a fake WYSIWYG bridge that returns `markdown` from getMarkdown(). */
function mountEditor(
  result: { current: NoteEditSession },
  markdown: string | Error,
) {
  const insertImage = vi.fn();
  act(() => {
    result.current.wysiwygRef.current = {
      getMarkdown: vi.fn(() =>
        markdown instanceof Error
          ? Promise.reject(markdown)
          : Promise.resolve(markdown),
      ),
      insertImage,
    } as unknown as NonNullable<typeof result.current.wysiwygRef.current>;
  });
  return { insertImage };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("entering and leaving edit mode", () => {
  it("seeds the markdown textarea with the FULL note, frontmatter included", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(NOTE);
    expect(result.current.selection).toEqual({ start: 0, end: 0 });
    expect(result.current.forceSelection).toBeNull();
  });

  it("seeds the rich editor with the BODY ONLY and the frontmatter tags as chips", () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    expect(result.current.wysiwygSeed).toBe(NOTE_BODY);
    expect(result.current.wysiwygSeed).not.toContain("---");
    expect(result.current.editTags).toEqual(["qa-test"]);
  });

  it("loads the vault tag index for autocomplete", async () => {
    vi.mocked(getTagIndex).mockResolvedValue({
      builtAt: 1,
      tags: [{ tag: "alpha", count: 2 }, { tag: "beta", count: 1 }],
    } as Awaited<ReturnType<typeof getTagIndex>>);
    const { result } = setup();
    await waitFor(() => expect(result.current.knownTags).toEqual(["alpha", "beta"]));
  });

  it("is dirty only once the markdown draft actually differs from disk", () => {
    const { result } = setup();
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.enterEdit());
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.setDraft(`${NOTE}extra`));
    expect(result.current.isDirty).toBe(true);
  });

  it("treats any rich-editor session as dirty (the WebView can't be diffed cheaply)", () => {
    const { result } = setup({ richEditorEnabled: true });
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.enterEdit());
    expect(result.current.isDirty).toBe(true);
  });

  it("cancels straight out when there is nothing to discard", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.cancelEdit());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(false);
    expect(result.current.draft).toBe("");
  });

  it("prompts before discarding real edits, and keeps them when asked", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${NOTE}extra`));
    act(() => result.current.cancelEdit());
    expect(result.current.discardVisible).toBe(true);
    // Still editing — nothing lost yet.
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(`${NOTE}extra`);

    act(() => result.current.keepEditing());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(`${NOTE}extra`);

    act(() => result.current.cancelEdit());
    act(() => result.current.confirmDiscard());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(false);
    expect(result.current.draft).toBe("");
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("replays the blocked navigation only after the discard is confirmed", () => {
    const replay = vi.fn();
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    act(() => result.current.showDiscardPrompt(replay));
    expect(result.current.discardVisible).toBe(true);
    expect(replay).not.toHaveBeenCalled();

    act(() => result.current.confirmDiscard());
    expect(replay).toHaveBeenCalledTimes(1);
    expect(result.current.editMode).toBe(false);
  });

  it("drops a pending replay when the user keeps editing", () => {
    const replay = vi.fn();
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    act(() => result.current.showDiscardPrompt(replay));
    act(() => result.current.keepEditing());
    // A later plain Cancel → Discard must NOT re-fire the stale navigation.
    act(() => result.current.cancelEdit());
    act(() => result.current.confirmDiscard());
    expect(replay).not.toHaveBeenCalled();
  });
});

describe("toolbar editing", () => {
  it("applies a real format transform and parks the caret after it", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("plain text"));
    act(() => result.current.setSelection({ start: 0, end: 5 }));
    act(() => result.current.applyFmt("bold"));

    expect(result.current.draft).toBe("**plain** text");
    expect(result.current.forceSelection).not.toBeNull();
    act(() => result.current.clearForceSelection());
    expect(result.current.forceSelection).toBeNull();
  });

  it("inserts the picked image as a relative embed at the caret", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue({
      rel: "../Photos/shot.jpg",
      dataUri: "data:image/jpeg;base64,AAA",
    } as Awaited<ReturnType<typeof pickAndWriteVaultImage>>);
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("before after"));
    act(() => result.current.setSelection({ start: 7, end: 7 }));
    await act(async () => {
      await result.current.insertImage();
    });

    expect(result.current.draft).toBe("before ![](../Photos/shot.jpg)after");
    expect(result.current.editError).toBeNull();
  });

  it("writes nothing into the draft when the picker is cancelled", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue(null);
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("untouched"));
    await act(async () => {
      await result.current.insertImage();
    });
    expect(result.current.draft).toBe("untouched");
  });

  it("surfaces an image-write failure in the save banner", async () => {
    vi.mocked(pickAndWriteVaultImage).mockRejectedValue(new Error("SAF denied"));
    const { result } = setup();
    act(() => result.current.enterEdit());
    await act(async () => {
      await result.current.insertImage();
    });
    expect(result.current.editError).toBe("SAF denied");
  });

  it("hands the rich editor both the relative link and the preview data URI", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue({
      rel: "../Photos/shot.jpg",
      dataUri: "data:image/jpeg;base64,AAA",
    } as Awaited<ReturnType<typeof pickAndWriteVaultImage>>);
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    const { insertImage } = mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.insertWysiwygImage();
    });
    expect(insertImage).toHaveBeenCalledWith(
      "../Photos/shot.jpg",
      "data:image/jpeg;base64,AAA",
    );
  });
});

describe("markdown save", () => {
  it("writes the draft verbatim, adopts it, and leaves edit mode", async () => {
    const edited = `${HEADER}# Renamed Note\n\nNew text.\n`;
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(edited));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(updateNote).toHaveBeenCalledWith(
      "file:///v/Ideas/draft-survival-test.md",
      edited,
    );
    expect(onBodyChange).toHaveBeenCalledWith(edited);
    expect(result.current.editMode).toBe(false);
    expect(result.current.saving).toBe(false);
    // H1 changed → the recents row is renamed to match.
    expect(updateCaptureTitle).toHaveBeenCalledWith("r1", "Renamed Note");
  });

  it("skips the recents-title write when the H1 is unchanged", async () => {
    const edited = `${HEADER}# Draft Survival Test\n\nOnly the body moved.\n`;
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(edited));
    await act(async () => {
      await result.current.handleSaveEdit();
    });
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });

  it("keeps the user in edit mode with a banner when the disk write fails", async () => {
    vi.mocked(updateNote).mockRejectedValueOnce(new Error("ENOSPC"));
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${NOTE}extra`));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(result.current.editError).toBe("ENOSPC");
    expect(result.current.editMode).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(result.current.draft).toBe(`${NOTE}extra`);
    expect(onBodyChange).not.toHaveBeenCalled();
    // The note never landed, so the recents title must not be renamed either.
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });

  it("still leaves edit mode when only the best-effort title write fails", async () => {
    vi.mocked(updateCaptureTitle).mockRejectedValueOnce(new Error("AsyncStorage"));
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${HEADER}# Renamed Note\n\nx\n`));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(onBodyChange).toHaveBeenCalled();
    expect(result.current.editMode).toBe(false);
    expect(result.current.editError).toBeNull();
  });
});

describe("rich (WYSIWYG) save", () => {
  it("reattaches the stashed frontmatter header byte-exact ahead of the edited body", async () => {
    const { result, onBodyChange } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, "# Draft Survival Test\n\nEdited in the WebView.\n");
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    const written = vi.mocked(updateNote).mock.calls[0][1];
    // Byte-exact header: same key order, same values, one delimiter pair.
    expect(written).toBe(
      `${HEADER}# Draft Survival Test\n\nEdited in the WebView.\n`,
    );
    expect(written.startsWith(HEADER)).toBe(true);
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(onBodyChange).toHaveBeenCalledWith(written);
    // Tags untouched → the vault index stays valid.
    expect(invalidateNoteIndex).not.toHaveBeenCalled();
  });

  it("skips the write entirely when the editor returns the on-disk content", async () => {
    const { result, onBodyChange } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    expect(updateNote).not.toHaveBeenCalled();
    expect(onBodyChange).not.toHaveBeenCalled();
    expect(result.current.editMode).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("rewrites the tags line and invalidates the index when chips change", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, NOTE_BODY);
    act(() => result.current.setEditTags(["qa-test", "added"]));
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    const written = vi.mocked(updateNote).mock.calls[0][1];
    expect(written).toContain("added");
    expect(written).toContain("qa-test");
    // The unrelated frontmatter key survives untouched.
    expect(written).toContain("created: 2026-07-08T11:55:46.000Z");
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(written.endsWith(NOTE_BODY)).toBe(true);
    expect(invalidateNoteIndex).toHaveBeenCalledTimes(1);
  });

  it("reports a bridge failure instead of hanging on a disabled Save", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, new Error("getMarkdown timed out"));
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    expect(result.current.editError).toBe("getMarkdown timed out");
    expect(result.current.editMode).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("errors rather than writing when Save is tapped before the editor mounts", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });
    expect(result.current.editError).toBe("Editor not mounted");
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("renames the recents row from the SAVED markdown's heading", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, "# Renamed In WebView\n\nBody.\n");
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });
    expect(updateCaptureTitle).toHaveBeenCalledWith("r1", "Renamed In WebView");
  });
});
