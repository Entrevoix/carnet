// @vitest-environment jsdom
//
// Screen smoke test for the browse-mode omnibox (pattern: see
// TagBrowserScreen.test.tsx). searchNotes is faked query-agnostic — the
// filtering behavior under test here is the SCREEN's own wiring: the
// collapsible filter pills, active-filter dismiss stamps, tag-param
// seeding, and AND-narrowing by tag.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { NoteIndexEntry } from "../lib/vault";

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(cb, [cb]);
    },
  };
});

const NOTES: NoteIndexEntry[] = [
  {
    uri: "file:///v/Ideas/first.md",
    subdir: "Ideas",
    title: "First idea",
    createdOrDate: 1_700_000_000_000,
    tags: ["qa-test"],
    mode: "idea",
    excerpt: "the first excerpt",
    status: "pending-enrich",
  },
  {
    uri: "file:///v/Journal/2026-07-08.md",
    subdir: "Journal",
    title: "A journal day",
    createdOrDate: 1_700_000_100_000,
    tags: ["sports"],
    mode: "journal",
    excerpt: "went to the game",
  },
];

vi.mock("../lib/vault", () => ({
  getNoteIndex: vi.fn(async () => ({ builtAt: 1, notes: NOTES })),
  refreshNoteIndex: vi.fn(async () => ({ builtAt: 2, notes: NOTES })),
  // Query-agnostic fake: returns every note. The screen's own tag-filter
  // narrowing runs on top of this and is what the assertions exercise.
  searchNotes: vi.fn((index: { notes: NoteIndexEntry[] }) => index.notes),
  searchNoteBodies: vi.fn(),
  resolveNoteEntry: vi.fn(async (uri: string) => ({
    id: "resolved-1",
    mode: "idea",
    title: "First idea",
    filepath: uri,
    createdAt: 1_700_000_000_000,
  })),
}));

import SearchScreen from "./SearchScreen";
import { resolveNoteEntry, searchNoteBodies } from "../lib/vault";

type ScreenProps = Parameters<typeof SearchScreen>[0];

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  };
}

function renderScreen(params?: { tag?: string }) {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <SearchScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "s", name: "Search", params } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("SearchScreen", () => {
  it("browses the vault as cards on an empty query, with tag + pending stamps", async () => {
    renderScreen();
    expect(await screen.findByText("First idea")).toBeTruthy();
    expect(screen.getByText("A journal day")).toBeTruthy();
    expect(screen.getByText("the first excerpt")).toBeTruthy();
    // Stamps from the shared NoteCard grammar.
    expect(screen.getByText("#qa-test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    // Filters are NOT docked — no pill row until the filter icon is tapped.
    expect(screen.queryByLabelText("Filter by tag qa-test")).toBeNull();
  });

  it("expands filter pills, narrows by tag, and dismisses via the active stamp", async () => {
    renderScreen();
    await screen.findByText("First idea");

    fireEvent.click(screen.getByLabelText("Show filters"));
    fireEvent.click(await screen.findByLabelText("Filter by tag qa-test"));

    // Row collapsed, results narrowed, dismiss stamp shown.
    await waitFor(() => expect(screen.queryByText("A journal day")).toBeNull());
    expect(screen.getByText("First idea")).toBeTruthy();
    const dismiss = screen.getByLabelText("Remove tag filter qa-test");

    fireEvent.click(dismiss);
    expect(await screen.findByText("A journal day")).toBeTruthy();
  });

  it("pre-applies a tag filter arriving via the route param", async () => {
    renderScreen({ tag: "sports" });
    expect(await screen.findByText("A journal day")).toBeTruthy();
    expect(screen.queryByText("First idea")).toBeNull();
    expect(screen.getByLabelText("Remove tag filter sports")).toBeTruthy();
  });

  it("opens a result via entry resolution", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByText("First idea"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", {
        entry: expect.objectContaining({ filepath: "file:///v/Ideas/first.md" }),
      }),
    );
    expect(resolveNoteEntry).toHaveBeenCalledWith("file:///v/Ideas/first.md");
  });
});

describe("body search", () => {
  it("shows the 'Search note contents' button only once a query is typed", async () => {
    renderScreen();
    await screen.findByText("First idea");
    expect(screen.queryByText("Search note contents")).toBeNull();

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
  });

  it("streams body matches as they resolve and shows a progress line", async () => {
    let onMatchCb!: (m: { uri: string; snippet: string }) => void;
    let onProgressCb!: (p: { scanned: number; total: number }) => void;
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, onMatch, onProgress, _signal) =>
        new Promise((resolve) => {
          onMatchCb = onMatch;
          onProgressCb = onProgress;
          // Deliberately never auto-resolves — the test drives it manually.
          void resolve;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalled());

    onProgressCb({ scanned: 1, total: 2 });
    onMatchCb({ uri: "file:///v/Journal/2026-07-08.md", snippet: "…matched text…" });

    await waitFor(() => expect(screen.getByText(/1 of 2 notes/)).toBeTruthy());
    expect(screen.getByText("…matched text…")).toBeTruthy();
  });

  it("cancels the in-flight scan when the query changes", async () => {
    const abortSpy = vi.fn();
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, _onMatch, _onProgress, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", abortSpy);
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    fireEvent.change(input, { target: { value: "hello world" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(abortSpy).toHaveBeenCalled();
  });

  it("ignores a superseded scan's callbacks after a new scan has started", async () => {
    let onMatchA!: (m: { uri: string; snippet: string }) => void;
    let onProgressA!: (p: { scanned: number; total: number }) => void;
    let onMatchB!: (m: { uri: string; snippet: string }) => void;
    let onProgressB!: (p: { scanned: number; total: number }) => void;

    // Scan A: captures its callbacks and never resolves on its own — the
    // test fires them manually, including AFTER scan B has started.
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, onMatch, onProgress, _signal) =>
        new Promise(() => {
          onMatchA = onMatch;
          onProgressA = onProgress;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(1));

    // Scan A delivers a match before it gets superseded.
    onProgressA({ scanned: 1, total: 5 });
    onMatchA({ uri: "file:///v/Journal/2026-07-08.md", snippet: "STALE_A_MATCH" });
    await waitFor(() => expect(screen.getByText(/1 of 5 notes/)).toBeTruthy());
    expect(screen.getByText("STALE_A_MATCH")).toBeTruthy();

    // Editing the query aborts scan A and resets the visible state.
    fireEvent.change(input, { target: { value: "hello world" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(screen.queryByText("STALE_A_MATCH")).toBeNull());

    // Scan B: a fresh search on the new query, captured separately.
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, onMatch, onProgress, _signal) =>
        new Promise(() => {
          onMatchB = onMatch;
          onProgressB = onProgress;
        }),
    );

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(2));

    onProgressB({ scanned: 1, total: 3 });
    onMatchB({ uri: "file:///v/Ideas/first.md", snippet: "FRESH_B_MATCH" });
    await waitFor(() => expect(screen.getByText(/1 of 3 notes/)).toBeTruthy());
    expect(screen.getByText("FRESH_B_MATCH")).toBeTruthy();

    // Scan A's stale callbacks fire late, after B is already the live scan.
    // Wrapped in act() so any (buggy, unguarded) state update is flushed
    // synchronously before the assertions below run — otherwise the
    // assertions could pass by accident just because React hadn't
    // re-rendered yet, regardless of whether the guard exists.
    act(() => {
      onProgressA({ scanned: 5, total: 5 });
      onMatchA({ uri: "file:///v/Journal/2026-07-08.md", snippet: "STALE_A_LATE_MATCH" });
    });

    // The stale delivery must not clobber B's progress or inject A's match.
    expect(screen.getByText(/1 of 3 notes/)).toBeTruthy();
    expect(screen.queryByText(/5 of 5 notes/)).toBeNull();
    expect(screen.queryByText("STALE_A_LATE_MATCH")).toBeNull();
    expect(screen.getByText("FRESH_B_MATCH")).toBeTruthy();
  });
});
