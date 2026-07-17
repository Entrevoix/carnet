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
}));
vi.mock("../lib/attachments", () => ({ pickAttachment: vi.fn() }));

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
import { readNote } from "../lib/writer";
import { removeFromHistory } from "../lib/storage";

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
});
