// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSettings: vi.fn() }));

import { getSettings } from "./settings";
import { useNoteDetailSettings } from "./useNoteDetailSettings";

type Settings = Awaited<ReturnType<typeof getSettings>>;

function settings(over: Partial<Settings>): Settings {
  return { richEditorEnabled: true, karakeepUrl: "", ...over } as Settings;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useNoteDetailSettings", () => {
  it("starts on the usable defaults before the read resolves", () => {
    vi.mocked(getSettings).mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useNoteDetailSettings());

    expect(result.current).toEqual({
      karakeepConfigured: false,
      richEditorEnabled: true,
    });
  });

  it("enables the Karakeep action once a non-blank instance URL loads", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      settings({ karakeepUrl: "https://keep.example" }),
    );

    const { result } = renderHook(() => useNoteDetailSettings());

    await waitFor(() => expect(result.current.karakeepConfigured).toBe(true));
  });

  it("treats a whitespace-only Karakeep URL as unconfigured", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ karakeepUrl: "   " }));

    const { result } = renderHook(() => useNoteDetailSettings());

    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalled());
    expect(result.current.karakeepConfigured).toBe(false);
  });

  it("reflects the persisted rich-editor flag when it is off", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ richEditorEnabled: false }));

    const { result } = renderHook(() => useNoteDetailSettings());

    await waitFor(() => expect(result.current.richEditorEnabled).toBe(false));
  });

  it("keeps the defaults when the settings read rejects", async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error("storage gone"));

    const { result } = renderHook(() => useNoteDetailSettings());

    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalled());
    expect(result.current).toEqual({
      karakeepConfigured: false,
      richEditorEnabled: true,
    });
  });
});
