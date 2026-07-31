// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./karakeepNoteExport", () => ({ exportNoteToKarakeep: vi.fn() }));
vi.mock("./pendingSync", () => ({ enqueuePendingExport: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import { Alert } from "react-native";
import { exportNoteToKarakeep } from "./karakeepNoteExport";
import { enqueuePendingExport } from "./pendingSync";
import { useKarakeepExport } from "./useKarakeepExport";

// karakeepExportUi + frontmatter are pure — imported for real, so the confirm
// gate and the outcome→plan translation are exercised, not stubbed.
const EXPORTED_NOTE =
  "---\ncreated: 2026-07-08T11:55:46.000Z\nkarakeepId: bm_abc\n---\n# T\n\nBody.\n";
const FRESH_NOTE = "---\ncreated: 2026-07-08T11:55:46.000Z\n---\n# T\n\nBody.\n";

function setup(body: string) {
  const onBodyChange = vi.fn();
  const hook = renderHook(() =>
    useKarakeepExport({
      body,
      filepath: "file:///v/Ideas/t.md",
      entryTitle: "T",
      onBodyChange,
    }),
  );
  return { ...hook, onBodyChange };
}

/** Drive the button and flush the export promise chain. */
async function send(result: { current: { handleSendToKarakeep: () => void } }) {
  await act(async () => {
    result.current.handleSendToKarakeep();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useKarakeepExport — confirm gate", () => {
  it("exports directly when the note has never been exported", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      nextBody: "STAMPED",
      didUpdate: false,
      skippedUnsupported: [],
    });
    const { result } = setup(FRESH_NOTE);
    await send(result);

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(exportNoteToKarakeep).toHaveBeenCalledTimes(1);
  });

  it("asks first when the note already carries a karakeepId", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      nextBody: "STAMPED",
      didUpdate: true,
      skippedUnsupported: [],
    });
    const { result } = setup(EXPORTED_NOTE);
    await send(result);

    expect(exportNoteToKarakeep).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = vi.mocked(Alert.alert).mock.calls[0];
    expect(title).toBe("Already exported");
    expect(buttons?.map((b) => b.text)).toEqual(["Cancel", "Update"]);

    // Confirming runs the export.
    await act(async () => {
      buttons?.[1].onPress?.();
      await Promise.resolve();
    });
    expect(exportNoteToKarakeep).toHaveBeenCalledTimes(1);
  });

  it("does nothing further if the confirm is cancelled", async () => {
    const { result } = setup(EXPORTED_NOTE);
    await send(result);
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2];
    // The Cancel button carries no handler at all — nothing can fire.
    expect(buttons?.[0].onPress).toBeUndefined();
    expect(exportNoteToKarakeep).not.toHaveBeenCalled();
  });
});

describe("useKarakeepExport — outcomes", () => {
  it("adopts the rewritten note and flips the create snackbar", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      // Deliberately unrelated to the input note, so a hook that echoed its
      // own `body` back instead of the export result would fail here.
      nextBody: "STAMPED-BODY",
      didUpdate: false,
      skippedUnsupported: [],
    });
    const { result, onBodyChange } = setup(FRESH_NOTE);
    await send(result);

    expect(onBodyChange).toHaveBeenCalledWith("STAMPED-BODY");
    expect(result.current.karakeepDone).toBe(true);
    expect(result.current.karakeepUpdated).toBe(false);
    expect(result.current.karakeepSkipNote).toBeNull();
    expect(result.current.karakeepError).toBeNull();
    expect(result.current.karakeepQueued).toBe(false);
    expect(result.current.exportingKarakeep).toBe(false);
  });

  it("reports an in-place update and carries the skip notice", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      nextBody: "STAMPED-BODY",
      didUpdate: true,
      skippedUnsupported: ["a.zip"],
    });
    const { result } = setup(FRESH_NOTE);
    await send(result);

    expect(result.current.karakeepUpdated).toBe(true);
    expect(result.current.karakeepSkipNote).toBe(
      "a.zip is a file type Karakeep doesn't accept — kept in the vault only",
    );
  });

  it("shows a real failure as an error and leaves the note alone", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "401 Unauthorized",
      unreachable: false,
    });
    const { result, onBodyChange } = setup(FRESH_NOTE);
    await send(result);

    expect(result.current.karakeepError).toBe("401 Unauthorized");
    expect(result.current.karakeepDone).toBe(false);
    expect(result.current.karakeepQueued).toBe(false);
    expect(onBodyChange).not.toHaveBeenCalled();
    expect(enqueuePendingExport).not.toHaveBeenCalled();
  });

  it("keeps the stamped body on a partial export but still shows the banner", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "partial",
      nextBody: "STAMPED-BODY",
      assetError: "upload 500",
      skippedUnsupported: [],
    });
    const { result, onBodyChange } = setup(FRESH_NOTE);
    await send(result);

    expect(onBodyChange).toHaveBeenCalledWith("STAMPED-BODY");
    expect(result.current.karakeepError).toBe(
      "Exported to Karakeep, but an attachment failed: upload 500",
    );
    // A partial is NOT a success — the snackbar must stay down.
    expect(result.current.karakeepDone).toBe(false);
  });

  it("queues an unreachable host instead of erroring", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "Network request failed",
      unreachable: true,
    });
    vi.mocked(enqueuePendingExport).mockResolvedValue(undefined);
    const { result } = setup(FRESH_NOTE);
    await send(result);

    expect(enqueuePendingExport).toHaveBeenCalledWith({
      filepath: "file:///v/Ideas/t.md",
      entryTitle: "T",
    });
    expect(result.current.karakeepQueued).toBe(true);
    expect(result.current.karakeepError).toBeNull();
  });

  it("falls back to the error banner when the queue write itself fails", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "Network request failed",
      unreachable: true,
    });
    vi.mocked(enqueuePendingExport).mockRejectedValue(new Error("storage full"));
    const { result } = setup(FRESH_NOTE);
    await send(result);

    expect(result.current.karakeepQueued).toBe(false);
    // The ORIGINAL export failure is what the user needs to see, not the
    // storage error that happened while trying to hide it.
    expect(result.current.karakeepError).toBe("Network request failed");
  });
});

describe("useKarakeepExport — guards and dismissal", () => {
  it("ignores a second tap while an export is in flight", async () => {
    let release: (() => void) | undefined;
    vi.mocked(exportNoteToKarakeep).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              kind: "exported",
              nextBody: "STAMPED-BODY",
              didUpdate: false,
              skippedUnsupported: [],
            });
        }),
    );
    const { result } = setup(FRESH_NOTE);
    act(() => {
      result.current.handleSendToKarakeep();
    });
    expect(result.current.exportingKarakeep).toBe(true);
    act(() => {
      result.current.handleSendToKarakeep();
    });
    expect(exportNoteToKarakeep).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(result.current.exportingKarakeep).toBe(false);
    // The guard releases, so a later tap works.
    await send(result);
    expect(exportNoteToKarakeep).toHaveBeenCalledTimes(2);
  });

  it("clears the previous error and skip note when a new export starts", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValueOnce({
      kind: "failed",
      reason: "401 Unauthorized",
      unreachable: false,
    });
    const { result } = setup(FRESH_NOTE);
    await send(result);
    expect(result.current.karakeepError).toBe("401 Unauthorized");

    vi.mocked(exportNoteToKarakeep).mockResolvedValueOnce({
      kind: "exported",
      nextBody: "STAMPED-BODY",
      didUpdate: false,
      skippedUnsupported: [],
    });
    await send(result);
    expect(result.current.karakeepError).toBeNull();
  });

  it("dismisses each snackbar independently", async () => {
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      nextBody: "STAMPED-BODY",
      didUpdate: false,
      skippedUnsupported: [],
    });
    const { result } = setup(FRESH_NOTE);
    await send(result);
    expect(result.current.karakeepDone).toBe(true);
    act(() => result.current.dismissKarakeepDone());
    expect(result.current.karakeepDone).toBe(false);

    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "down",
      unreachable: true,
    });
    vi.mocked(enqueuePendingExport).mockResolvedValue(undefined);
    await send(result);
    expect(result.current.karakeepQueued).toBe(true);
    act(() => result.current.dismissKarakeepQueued());
    expect(result.current.karakeepQueued).toBe(false);
  });

  it("does not setState after unmount, but still queues the retry", async () => {
    let release: (() => void) | undefined;
    vi.mocked(exportNoteToKarakeep).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ kind: "failed", reason: "down", unreachable: true });
        }),
    );
    vi.mocked(enqueuePendingExport).mockResolvedValue(undefined);
    const { result, unmount } = setup(FRESH_NOTE);
    act(() => {
      result.current.handleSendToKarakeep();
    });
    unmount();
    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The retry must survive a Back-during-export...
    expect(enqueuePendingExport).toHaveBeenCalledTimes(1);
    // ...but the snackbar state must not be touched.
    expect(result.current.karakeepQueued).toBe(false);
  });
});
