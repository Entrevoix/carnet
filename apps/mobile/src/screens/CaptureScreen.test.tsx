// @vitest-environment jsdom
//
// Screen smoke test for the capture flow, Idea mode (pattern: see
// TagBrowserScreen.test.tsx). Native capture surfaces (voice, card scanner)
// are mocked out; the flow under test is the screen's own wiring: the
// distraction-free input, draft restore/autosave, the metadata sheet, the
// save-first Send path, and the degraded-enrichment state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

// Native speech stack — irrelevant here; the ref API must exist.
vi.mock("../voice/VoiceButton", async () => {
  const { forwardRef } = await import("react");
  return {
    VoiceButton: forwardRef(() => null),
  };
});

// expo-camera OCR modal.
vi.mock("../components/CardScannerModal", () => ({
  CardScannerModal: () => null,
}));

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({ previewBeforeSave: false })),
}));

vi.mock("../lib/storage", () => ({
  recordCapture: vi.fn(async () => {}),
}));

vi.mock("../lib/dispatcher", () => ({
  enrichIdea: vi.fn(),
  enrichJournal: vi.fn(),
  enrichPerson: vi.fn(),
  isPermanentError: vi.fn(() => false),
  isNotConfiguredError: vi.fn(() => false),
  promoteIdea: vi.fn(),
}));

vi.mock("../lib/writer", () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  writeIdea: vi.fn(),
  appendJournal: vi.fn(),
  writePerson: vi.fn(),
  writeBinary: vi.fn(),
  injectAttachments: vi.fn((md: string) => md),
  injectPlaces: vi.fn((md: string, places: { name: string; coords: { lat: number; lon: number } }[]) =>
    places.length === 0
      ? md
      : `${md}\n\n## Places\n\n${places
          .map((pl) => `[${pl.name}](geo:${pl.coords.lat},${pl.coords.lon})`)
          .join("\n\n")}\n`,
  ),
  extFromMime: vi.fn(() => "jpg"),
  readNote: vi.fn(),
  updateNoteIfUnchanged: vi.fn(),
  getModificationTime: vi.fn(async () => 1),
  rewriteFrontmatterField: vi.fn((md: string) => md),
  extractNameFromMarkdown: vi.fn(() => ({ firstName: "A", lastName: "B" })),
}));

vi.mock("../lib/ideaSaveFirst", () => ({
  writeRawIdea: vi.fn(async () => ({
    filepath: "file:///v/Ideas/my-idea.md",
    slug: "my-idea",
    mtime: 111,
    markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
  })),
  enrichIdeaInPlace: vi.fn(async () => ({
    kind: "updated",
    markdown: "---\n---\n# My Idea\n\nmy idea\n",
  })),
}));

// Place resolution is network/native-backed; unit-tested in mapsLink.test.ts
// and location.test.ts. Here we only care that resolved places reach the save.
vi.mock("../lib/mapsLink", () => ({ resolveMapsLink: vi.fn() }));
vi.mock("../lib/location", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/location")>();
  return { ...actual, resolvePlaceName: vi.fn() };
});

vi.mock("../lib/attachments", () => ({
  pickAttachment: vi.fn(async () => null),
}));

vi.mock("../lib/captureDraft", () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
}));

vi.mock("../lib/queue", () => ({
  enqueue: vi.fn(async () => {}),
  drainQueue: vi.fn(async () => {}),
  getQueueDepth: vi.fn(async () => 0),
}));

vi.mock("../lib/vault", () => ({
  getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
  upsertNoteInIndex: vi.fn(async () => {}),
}));

import CaptureScreen from "./CaptureScreen";
import { loadDraft, saveDraft, clearDraft } from "../lib/captureDraft";
import { writeRawIdea, enrichIdeaInPlace } from "../lib/ideaSaveFirst";
import { getSettings } from "../lib/settings";
import { enrichIdea } from "../lib/dispatcher";
import { recordCapture } from "../lib/storage";
import { upsertNoteInIndex } from "../lib/vault";
import { enrichJournal } from "../lib/dispatcher";
import { appendJournal } from "../lib/writer";
import { resolvePlaceName } from "../lib/location";

type ScreenProps = Parameters<typeof CaptureScreen>[0];

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  };
}

function renderScreen(mode: "idea" | "journal" | "person" = "idea") {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <CaptureScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={
          { key: "c", name: "Capture", params: { mode } } as ScreenProps["route"]
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

describe("CaptureScreen (idea)", () => {
  it("starts distraction-free: input + disabled Send, metadata behind '+'", async () => {
    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    expect(input).toBeTruthy();
    expect(screen.getByText("0 chars")).toBeTruthy();
    // No tag/location/attachment chrome docked in the writing surface.
    expect(screen.queryByText("Tags & details")).toBeNull();
    // Send exists but is disabled with no text — clicking must be a no-op.
    fireEvent.click(screen.getByText("Send"));
    expect(writeRawIdea).not.toHaveBeenCalled();
  });

  it("restores a persisted draft into the input", async () => {
    vi.mocked(loadDraft).mockResolvedValueOnce({
      text: "half a thought",
      transcript: "",
      ocrText: "",
      savedAt: 1,
    });
    renderScreen();
    expect(await screen.findByDisplayValue("half a thought")).toBeTruthy();
  });

  it("autosaves the draft while typing (debounced)", async () => {
    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "typing away" } });
    await waitFor(
      () =>
        expect(saveDraft).toHaveBeenCalledWith(
          "idea",
          expect.objectContaining({ text: "typing away" }),
        ),
      { timeout: 2000 },
    );
  });

  it("opens the Tags & details sheet from the '+' button", async () => {
    renderScreen();
    await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.click(
      screen.getByLabelText("Add tags, location, or attachments"),
    );
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(screen.getByText("Image")).toBeTruthy();
    expect(screen.getByText("File")).toBeTruthy();
  });

  it("save-first Send: writes the raw note, records it, upserts the index, clears the draft, and closes on enrichment success", async () => {
    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ text: "my idea" }),
    );
    expect(recordCapture).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
    );
    // Raw write upsert + enriched upsert.
    expect(upsertNoteInIndex).toHaveBeenCalledTimes(2);
    expect(clearDraft).toHaveBeenCalledWith("idea");
  });

  it("permanent enrichment failure keeps the note and offers Re-enrich in plain language", async () => {
    vi.mocked(enrichIdeaInPlace).mockResolvedValueOnce({
      kind: "failed",
      transient: false,
      reason: "model exploded",
    });
    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("Saved to vault")).toBeTruthy();
    expect(
      screen.getByText(/Your note is safe in the vault/),
    ).toBeTruthy();
    expect(screen.getByText("Re-enrich")).toBeTruthy();
    // The screen stays open for the user to decide — no auto-dismiss.
    expect(navigation.goBack).not.toHaveBeenCalled();
    // The raw note was still written and recorded before the failure.
    expect(writeRawIdea).toHaveBeenCalled();
    expect(recordCapture).toHaveBeenCalled();
  });

  it("submitting-phase label names the configured backend, not a hardcoded OmniRoute", async () => {
    // Blocking-preview path (previewBeforeSave: true) calls enrichIdea
    // directly, which is where the "submitting" phase is actually visible —
    // the default save-first path resolves too fast in tests to observe it.
    vi.mocked(getSettings).mockResolvedValueOnce({
      previewBeforeSave: true,
      activeProviderId: "relais",
    } as Awaited<ReturnType<typeof getSettings>>);
    let resolveEnrich!: (v: { markdown: string; model: string }) => void;
    vi.mocked(enrichIdea).mockReturnValueOnce(
      new Promise((res) => {
        resolveEnrich = res;
      }),
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    expect(
      await screen.findByText("Local LLM is structuring the note…"),
    ).toBeTruthy();
    expect(screen.queryByText("OmniRoute is structuring the note…")).toBeNull();

    resolveEnrich({ markdown: "# My Idea\n\nbody\n", model: "local-model" });
  });
});

describe("CaptureScreen (journal) — places", () => {
  // vi.clearAllMocks() keeps implementations, so a mockResolvedValue set here
  // would outlive the test — put the module default back explicitly.
  afterEach(() => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: false,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
  });

  /** Type a place name into the meta sheet's Places field and press Add. */
  async function addPlace(name: string, lat: number, lon: number): Promise<void> {
    vi.mocked(resolvePlaceName).mockResolvedValueOnce({
      kind: "ok",
      place: name,
      coords: { lat, lon },
    });
    fireEvent.change(screen.getByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  }

  it("shows the Places field for Journal captures only", async () => {
    renderScreen("journal");
    await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(screen.getByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…")).toBeTruthy();
  });

  it("shows no Places field for Idea captures", async () => {
    renderScreen("idea");
    await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…"),
    ).toBeNull();
  });

  it("writes both added places into the saved journal entry body", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: true,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(enrichJournal).mockResolvedValue({
      markdown: "# Travel day\n\nThree stops.\n",
      model: "test-model",
    } as unknown as Awaited<ReturnType<typeof enrichJournal>>);
    vi.mocked(appendJournal).mockResolvedValue({
      filepath: "file:///v/Journal/2026-08-11.md",
      markdown: "<day-file>",
    } as unknown as Awaited<ReturnType<typeof appendJournal>>);

    renderScreen("journal");
    const transcript = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(transcript, { target: { value: "three stops today" } });

    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    await screen.findByText("Tags & details");
    await addPlace("Rud-Alpe", 47.2011, 10.1166);
    await addPlace("Lech", 47.2063, 10.1435);
    fireEvent.click(screen.getByText("Done"));

    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(appendJournal).toHaveBeenCalled());
    const body = vi.mocked(appendJournal).mock.calls[0][1];
    expect(body).toContain("## Places");
    expect(body).toContain("[Rud-Alpe](geo:47.2011,10.1166)");
    expect(body).toContain("[Lech](geo:47.2063,10.1435)");
  });
});
