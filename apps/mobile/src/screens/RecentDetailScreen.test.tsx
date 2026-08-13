// @vitest-environment jsdom
//
// Screen smoke test for the content-first note detail (pattern: see
// TagBrowserScreen.test.tsx). The writer mock delegates its frontmatter
// helpers to the REAL pure ../lib/frontmatter module (writer only
// re-exports them), so the stamp row and body rendering exercise real
// parsing; file I/O and the WYSIWYG/audio/karakeep stacks are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { CaptureEntry } from "../lib/storage";

const NOTE_MD =
  "---\ncreated: 2026-07-08T11:55:46.000Z\nstatus: pending-enrich\ntags: [qa-test]\n---\n# Draft Survival Test\n\nHello body text.\n";

vi.mock("../lib/writer", async () => {
  const fm = await import("../lib/frontmatter");
  return {
    // Real pure helpers (writer re-exports these from ./frontmatter).
    extractFrontmatterField: fm.extractFrontmatterField,
    stripFrontmatter: fm.stripFrontmatter,
    splitFrontmatter: fm.splitFrontmatter,
    // Writer-defined pure helpers, faked minimally: no paired binaries in
    // the fixture note.
    listPairedBinaries: vi.fn(() => []),
    stripPairedBinaryLinks: vi.fn((md: string) => md),
    resolvePairedUri: vi.fn(async () => null),
    readPairedBinaryFromNote: vi.fn(async () => {
      throw new Error("no binary");
    }),
    readPairedBinaryUri: vi.fn(async () => {
      throw new Error("no binary");
    }),
    // I/O surface.
    readNote: vi.fn(async () => NOTE_MD),
    updateNote: vi.fn(async () => {}),
    updateNoteIfUnchanged: vi.fn(async () => ({ ok: true })),
    getModificationTime: vi.fn(async () => 1),
    moveToArchive: vi.fn(async () => {}),
    writeBinary: vi.fn(),
    slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
    extFromMime: vi.fn(() => "jpg"),
    upsertSection: vi.fn((md: string) => md),
    injectImageEmbed: vi.fn((md: string) => md),
  };
});

// relatedNotes is pure — imported real; the index feed below controls it.
vi.mock("../lib/vault", async () => {
  const fm = await import("../lib/frontmatter");
  return {
    getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
    invalidateNoteIndex: vi.fn(async () => {}),
    tagsForNote: (md: string) => fm.getFrontmatterTags(md),
    // null index → the Related card stays hidden in existing tests.
    loadCachedNoteIndex: vi.fn(async () => null),
    resolveNoteEntry: vi.fn(async () => null),
  };
});

vi.mock("../lib/storage", () => ({
  removeFromHistory: vi.fn(async () => {}),
  removeFromHistoryByFilepath: vi.fn(async () => {}),
  updateCaptureTitle: vi.fn(async () => {}),
}));

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({
    richEditorEnabled: true,
    karakeepUrl: "",
  })),
}));

vi.mock("../lib/karakeep", () => ({
  attachTags: vi.fn(),
  createTextBookmark: vi.fn(),
  updateTextBookmark: vi.fn(),
  KarakeepError: class KarakeepError extends Error {},
}));
vi.mock("../lib/karakeepExport", () => ({ pushNoteAttachments: vi.fn() }));
vi.mock("../lib/karakeepInlineImages", () => ({
  rewriteImageEmbedsToAssetUrls: vi.fn((md: string) => md),
}));
vi.mock("../lib/karakeepAssetSync", () => ({ clearPushedAssets: vi.fn() }));
// pendingSync pulls AsyncStorage's native binding — never load the real one.
vi.mock("../lib/pendingSync", () => ({ enqueuePendingExport: vi.fn() }));

vi.mock("../lib/dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  transcribeAudio: vi.fn(),
  // Real constant (not a mock target) — RecentDetailScreen imports it to
  // read the Phase 3 fallback marker back out of a note's frontmatter.
  FALLBACK_PROVIDER_FIELD: "fallback",
}));
vi.mock("../lib/attachments", () => ({ pickAttachment: vi.fn() }));
vi.mock("../lib/attachPhotoToNote", () => ({ attachPhotoToNote: vi.fn() }));
// expo-camera is a native module; the modal's own behavior is covered in
// PhotoAttachModal.test.tsx. Here it is a dispatch stub for the wiring.
vi.mock("../components/PhotoAttachModal", async () => {
  const { Button } = await import("react-native-paper");
  return {
    PhotoAttachModal: ({
      visible,
      onCaptured,
    }: {
      visible: boolean;
      onCaptured: (b: string, m: string, n?: string) => void;
    }) =>
      visible ? (
        <Button onPress={() => onCaptured("AAAA", "image/jpeg", undefined)}>
          fake-shutter
        </Button>
      ) : null,
  };
});

// react-native-markdown-display ships raw JSX in .js files, which vite
// can't parse once the package is inlined. Markdown → native rendering
// isn't what this smoke test covers; a passthrough keeps the body text
// findable.
vi.mock("react-native-markdown-display", async () => {
  const { Text } = await import("react-native");
  return {
    default: ({ children }: { children?: unknown }) => (
      <Text>{String(children ?? "")}</Text>
    ),
  };
});

// WebView-backed editor and native AV — out of smoke-test scope.
vi.mock("../components/WysiwygEditor", async () => {
  const { forwardRef } = await import("react");
  return { WysiwygEditor: forwardRef(() => null) };
});
vi.mock("expo-av", () => ({
  Audio: { Sound: { createAsync: vi.fn() } },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

import RecentDetailScreen from "./RecentDetailScreen";
import { readNote, updateNote } from "../lib/writer";
import { removeFromHistory } from "../lib/storage";
import { attachPhotoToNote } from "../lib/attachPhotoToNote";

type ScreenProps = Parameters<typeof RecentDetailScreen>[0];

import { loadCachedNoteIndex, resolveNoteEntry } from "../lib/vault";

const ENTRY: CaptureEntry = {
  id: "r1",
  mode: "idea",
  title: "Draft Survival Test",
  filepath: "file:///v/Ideas/draft-survival-test.md",
  createdAt: 1_751_975_746_000,
};

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    push: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    dispatch: vi.fn(),
  };
}

function renderScreen() {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <RecentDetailScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={
          {
            key: "d",
            name: "RecentDetail",
            params: { entry: ENTRY },
          } as ScreenProps["route"]
        }
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RecentDetailScreen", () => {
  it("renders content-first: body + stamp row, no raw file path in the reading flow", async () => {
    renderScreen();
    expect(await screen.findByText(/Hello body text\./)).toBeTruthy();
    // Stamp row from real frontmatter parsing.
    expect(screen.getByText("Idea")).toBeTruthy();
    expect(screen.getByText("#qa-test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    // The path lives in File info, not on the reading surface.
    expect(screen.queryByText(ENTRY.filepath)).toBeNull();
    // Single primary action.
    expect(screen.getByLabelText("Edit note")).toBeTruthy();
  });

  it("renders the Related card from the cached index and opens a hit with push (Back-able)", async () => {
    const relatedEntry = {
      uri: "file:///v/Ideas/other-qa-note.md",
      subdir: "Ideas" as const,
      title: "Other QA note",
      createdOrDate: 5,
      tags: ["qa-test"],
      mode: "idea" as const,
      excerpt: "",
    };
    vi.mocked(loadCachedNoteIndex).mockResolvedValue({
      builtAt: 1,
      notes: [relatedEntry],
    } as Awaited<ReturnType<typeof loadCachedNoteIndex>>);
    const target = {
      id: "r2",
      mode: "idea" as const,
      title: "Other QA note",
      filepath: relatedEntry.uri,
      createdAt: 1,
    };
    vi.mocked(resolveNoteEntry).mockResolvedValue(target);

    const { navigation } = renderScreen();
    // Shares the #qa-test tag with the open note → scores → card renders.
    expect(await screen.findByText("Related")).toBeTruthy();
    fireEvent.click(screen.getByText("Other QA note"));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("RecentDetail", {
        entry: target,
      }),
    );
  });

  it("link-plus persists a [[wikilink]] under ## Related and confirms via snackbar", async () => {
    const relatedEntry = {
      uri: "file:///v/Ideas/other-qa-note.md",
      subdir: "Ideas" as const,
      title: "Other QA note",
      createdOrDate: 5,
      tags: ["qa-test"],
      mode: "idea" as const,
      excerpt: "",
    };
    vi.mocked(loadCachedNoteIndex).mockResolvedValue({
      builtAt: 1,
      notes: [relatedEntry],
    } as Awaited<ReturnType<typeof loadCachedNoteIndex>>);

    renderScreen();
    await screen.findByText("Related");
    fireEvent.click(
      screen.getByLabelText("Link Other QA note into this note"),
    );

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    const written = vi.mocked(updateNote).mock.calls[0][1];
    expect(written).toContain("## Related");
    expect(written).toContain("- [[Other QA note]]");
    expect(
      await screen.findByText("Linked [[Other QA note]] under Related"),
    ).toBeTruthy();
  });

  it("tag stamp opens pre-filtered Search", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByLabelText("Search notes tagged qa-test"));
    expect(navigation.navigate).toHaveBeenCalledWith("Search", { tag: "qa-test" });
  });

  it("header overflow opens the actions sheet; File info reveals the path; Delete asks first", async () => {
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    // The ⋮ lives in the navigation header (outside this tree) — render the
    // headerRight the screen installed and drive it; state flows back into
    // the screen's Portal because the closure shares the component instance.
    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    expect(withHeader).toBeTruthy();
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(await screen.findByText("File info")).toBeTruthy();
    // Idea notes: no re-enrich/transcribe rows, Karakeep unconfigured.
    expect(screen.queryByText("Re-enrich")).toBeNull();
    expect(screen.queryByText("Transcribe")).toBeNull();
    expect(screen.queryByText("Send to Karakeep")).toBeNull();

    fireEvent.click(screen.getByText("File info"));
    expect(await screen.findByText(ENTRY.filepath)).toBeTruthy();

    // Reopen the sheet; Delete routes through the confirm dialog.
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Delete"));
    expect(await screen.findByText("Move to Archive?")).toBeTruthy();
  });

  it("Attach photo opens the camera modal and a shot dispatches to attachPhotoToNote", async () => {
    vi.mocked(attachPhotoToNote).mockResolvedValue({
      kind: "attached",
      rel: "../Photos/photo.jpg",
      nextBody: `${NOTE_MD.trimEnd()}\n\n![](../Photos/photo.jpg)\n`,
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));

    fireEvent.click(await screen.findByText("Attach photo"));
    fireEvent.click(await screen.findByText("fake-shutter"));

    await waitFor(() =>
      expect(attachPhotoToNote).toHaveBeenCalledWith({
        filepath: ENTRY.filepath,
        base64: "AAAA",
        mime: "image/jpeg",
        basename: undefined,
      }),
    );
    // The refreshed body comes back from the lib module, not a local splice.
    expect(await screen.findByText("Photo attached.")).toBeTruthy();
  });

  it("surfaces a refused attach in the banner slot", async () => {
    vi.mocked(attachPhotoToNote).mockResolvedValue({
      kind: "failed",
      reason: "The note was written to from somewhere else.",
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Attach photo"));
    fireEvent.click(await screen.findByText("fake-shutter"));

    expect(
      await screen.findByText(
        /Attach photo failed: The note was written to from somewhere else\./,
      ),
    ).toBeTruthy();
  });

  it("missing file shows the dedicated state and Remove from list works", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    const { navigation } = renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();
    // No Edit FAB in the missing state.
    expect(screen.queryByLabelText("Edit note")).toBeNull();

    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
  });

  // #114. handleDelete catches everything and always reaches goBack(), but
  // handleRemoveFromHistory had no try/catch: a rejection skipped goBack() AND
  // left the shared deletingRef latched true, so BOTH destructive actions were
  // dead for the rest of the screen's life with no feedback.
  it("a failing Remove from list does not permanently latch the screen (#114)", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    vi.mocked(removeFromHistory).mockRejectedValueOnce(new Error("disk full"));
    const { navigation } = renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();

    // First attempt fails.
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(1));

    // The guard must have been released: a retry actually re-invokes it.
    // Without the finally-reset this second click is swallowed by the latch.
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
  });

  it("still guards against a double-tap while a removal is in flight (#114)", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    let release!: () => void;
    vi.mocked(removeFromHistory).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = () => resolve(); }),
    );
    renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();

    fireEvent.click(screen.getByText("Remove from list"));
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(1));
    release();
  });
});
