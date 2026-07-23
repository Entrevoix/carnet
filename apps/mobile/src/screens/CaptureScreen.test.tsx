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
      llmBackend: "local",
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
