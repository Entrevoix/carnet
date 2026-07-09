// @vitest-environment jsdom
//
// Screen smoke test for the browse-mode omnibox (pattern: see
// TagBrowserScreen.test.tsx). searchNotes is faked query-agnostic — the
// filtering behavior under test here is the SCREEN's own wiring: the
// collapsible filter pills, active-filter dismiss stamps, tag-param
// seeding, and AND-narrowing by tag.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  resolveNoteEntry: vi.fn(async (uri: string) => ({
    id: "resolved-1",
    mode: "idea",
    title: "First idea",
    filepath: uri,
    createdAt: 1_700_000_000_000,
  })),
}));

import SearchScreen from "./SearchScreen";
import { resolveNoteEntry } from "../lib/vault";

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
