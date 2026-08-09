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
  removeFromHistoryByFilepath: vi.fn(async () => {}),
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
  rewriteRawIdea: vi.fn(async () => ({
    filepath: "file:///v/Ideas/my-idea.md",
    mtime: 222,
    markdown: "---\nstatus: pending-enrich\n---\nmy edited idea\n",
  })),
  enrichIdeaInPlace: vi.fn(async () => ({
    kind: "updated",
    markdown: "---\n---\n# My Idea\n\nmy idea\n",
  })),
}));

vi.mock("../lib/attachments", () => ({
  pickAttachment: vi.fn(async () => null),
}));

vi.mock("../lib/attachmentPersistence", () => ({
  persistAttachments: vi.fn(async () => []),
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
import { writeRawIdea, rewriteRawIdea, enrichIdeaInPlace } from "../lib/ideaSaveFirst";
import { getSettings } from "../lib/settings";
import { enrichIdea, enrichJournal, enrichPerson } from "../lib/dispatcher";
import { recordCapture } from "../lib/storage";
import { enqueue } from "../lib/queue";
import { persistAttachments } from "../lib/attachmentPersistence";
import { clearDraft as clearDraftMock } from "../lib/captureDraft";
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

// ── Edit during "submitting" — the non-blocking escape hatch ──────────────────

/** A promise the test resolves by hand, so the enrichment can be held in
 * flight while the Edit affordance is exercised. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CaptureScreen — Edit during enrichment", () => {
  it("idea: restores the draft and ignores the enrichment that lands afterwards", async () => {
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    // The raw note is already on disk; the input was cleared by save-first.
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Edit"));

    // Back to an editable draft carrying the user's original text.
    expect(await screen.findByDisplayValue("my idea")).toBeTruthy();

    // The abandoned call lands late — it must not steer the screen.
    enrich.resolve({ kind: "updated", markdown: "# Enriched\n" });
    await waitFor(() => expect(screen.getByDisplayValue("my idea")).toBeTruthy());
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved to vault")).toBeNull();
  });

  it("idea: resubmitting after Edit overwrites the same file instead of writing a twin", async () => {
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Edit"));

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "my edited idea",
        filepath: "file:///v/Ideas/my-idea.md",
      }),
    );
    // The whole point: no second raw write, so no orphaned -2.md.
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("journal: keeps the transcript and ignores the late enrichment", async () => {
    const enrich = deferred<{ markdown: string; model: string }>();
    vi.mocked(enrichJournal).mockReturnValueOnce(enrich.promise);

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));

    fireEvent.click(await screen.findByText("Edit"));
    expect(await screen.findByDisplayValue("walked the dog")).toBeTruthy();

    enrich.resolve({ markdown: "# Journal\n", model: "m" });
    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    // No preview card — the abandoned result never reached the UI.
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("person: keeps the card text and ignores the late enrichment", async () => {
    const enrich = deferred<{ markdown: string; model: string }>();
    vi.mocked(enrichPerson).mockReturnValueOnce(enrich.promise);

    renderScreen("person");
    const input = await screen.findByPlaceholderText("Card text — scan or type");
    fireEvent.change(input, { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByText("Send"));

    fireEvent.click(await screen.findByText("Edit"));
    expect(await screen.findByDisplayValue("Ada Lovelace")).toBeTruthy();

    enrich.resolve({ markdown: "# Ada\n", model: "m" });
    await waitFor(() => expect(screen.getByDisplayValue("Ada Lovelace")).toBeTruthy());
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("journal: a late enrichment FAILURE is also swallowed after Edit", async () => {
    // Without the guard, handleCaptureError would queue the capture and wipe
    // the transcript the user just returned to editing.
    let reject!: (e: Error) => void;
    vi.mocked(enrichJournal).mockReturnValueOnce(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(await screen.findByText("Edit"));

    reject(new Error("network down"));
    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    expect(screen.queryByText("Offline — capture queued.")).toBeNull();
  });
});

describe("CaptureScreen — Edit race conditions", () => {
  it("a stale enrichment from the FIRST submit cannot drive the screen after a resubmit", async () => {
    // The bug a boolean abort flag has: the second submit clears the flag, which
    // un-cancels call #1, whose late resolution then closed the screen.
    const first = deferred<{ kind: "updated"; markdown: string }>();
    const second = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace)
      .mockReturnValueOnce(first.promise as ReturnType<typeof enrichIdeaInPlace>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof enrichIdeaInPlace>);

    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());

    // Submit #1's abandoned call finally lands, while #2 is still in flight.
    first.resolve({ kind: "updated", markdown: "# Stale\n" });
    await waitFor(() => expect(screen.getByText(/structuring the note/)).toBeTruthy());
    expect(navigation.goBack).not.toHaveBeenCalled();

    // Submit #2 still owns the screen and completes normally.
    second.resolve({ kind: "updated", markdown: "# Fresh\n" });
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
  });

  it("Edit tapped BEFORE the raw write resolves still routes the resubmit to rewriteRawIdea", async () => {
    // editingFilepath comes from the write's own result, so Edit has to wait for
    // it — otherwise the resubmit writes a second file and orphans the first.
    const write = deferred<{
      filepath: string;
      slug: string;
      mtime: number;
      markdown: string;
    }>();
    vi.mocked(writeRawIdea).mockReturnValueOnce(
      write.promise as ReturnType<typeof writeRawIdea>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    // Tap Edit while the write is still in flight.
    fireEvent.click(await screen.findByText("Edit"));
    write.resolve({
      filepath: "file:///v/Ideas/my-idea.md",
      slug: "my-idea",
      mtime: 111,
      markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
    });

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
    );
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("the interrupted write's own continuation does not clear the restored draft", async () => {
    const write = deferred<{
      filepath: string;
      slug: string;
      mtime: number;
      markdown: string;
    }>();
    vi.mocked(writeRawIdea).mockReturnValueOnce(
      write.promise as ReturnType<typeof writeRawIdea>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(await screen.findByText("Edit"));

    write.resolve({
      filepath: "file:///v/Ideas/my-idea.md",
      slug: "my-idea",
      mtime: 111,
      markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
    });

    // The superseded write must not run its post-write bookkeeping.
    expect(await screen.findByDisplayValue("my idea")).toBeTruthy();
    await waitFor(() => expect(recordCapture).not.toHaveBeenCalled());
  });
});

describe("CaptureScreen — Edit during a multi-await continuation", () => {
  it("Edit landing between the raw write and recordCapture still routes the resubmit to rewriteRawIdea", async () => {
    // recordCapture resolves AFTER the Edit tap: the continuation resumes and
    // would clear editingFilepath, undoing the tap and orphaning a duplicate.
    const record = deferred<void>();
    vi.mocked(recordCapture).mockReturnValueOnce(record.promise);

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(recordCapture).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    await screen.findByDisplayValue("my idea");
    record.resolve();

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
    );
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("Edit landing mid-handleCaptureError does not wipe the restored draft or the saved draft file", async () => {
    // handleCaptureError runs with the Edit button still on screen and clears
    // every input once the enqueue lands — including the draft the user just
    // went back to editing, while the un-edited capture stays queued.
    const queued = deferred<void>();
    vi.mocked(enrichJournal).mockRejectedValueOnce(new Error("network down"));
    vi.mocked(enqueue).mockReturnValueOnce(queued.promise);

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    queued.resolve();

    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    expect(screen.queryByText("Offline — capture queued.")).toBeNull();
    expect(clearDraftMock).not.toHaveBeenCalled();
  });

  it("Edit landing during persistAttachments writes no note at all, so the resubmit writes exactly one", async () => {
    // The earliest await in the save-first path, upstream of rawWriteRef being
    // published: an unguarded resume here writes note A anyway, and the
    // resubmit then writes note B — two files for one capture.
    const persisted = deferred<never[]>();
    vi.mocked(persistAttachments).mockReturnValueOnce(
      persisted.promise as ReturnType<typeof persistAttachments>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(persistAttachments).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    persisted.resolve([]);

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());
    // Nothing reached disk before the Edit, so this is a fresh capture — one
    // write total, and no rewrite of a file that was never created.
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ text: "my edited idea" }),
    );
    expect(rewriteRawIdea).not.toHaveBeenCalled();
  });
});
