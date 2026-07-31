// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-av", () => ({
  Audio: { Sound: { createAsync: vi.fn() } },
}));
vi.mock("./writer", () => ({
  readPairedBinaryUri: vi.fn(),
}));

import { Audio } from "expo-av";
import { readPairedBinaryUri } from "./writer";
import { nextPlaybackAction, useNoteAudioPlayer } from "./useNoteAudioPlayer";

type StatusCallback = (status: {
  isLoaded: boolean;
  isPlaying?: boolean;
  positionMillis?: number;
  durationMillis?: number;
  didJustFinish?: boolean;
}) => void;

/** A fake expo-av Sound recording which transport calls were made, in order. */
function makeSound(status: {
  isLoaded: boolean;
  isPlaying: boolean;
  positionMillis: number;
  durationMillis?: number;
}) {
  const calls: string[] = [];
  return {
    calls,
    getStatusAsync: vi.fn(async () => status),
    pauseAsync: vi.fn(async () => void calls.push("pause")),
    playAsync: vi.fn(async () => void calls.push("play")),
    setPositionAsync: vi.fn(async (p: number) => void calls.push(`seek:${p}`)),
    unloadAsync: vi.fn(async () => void calls.push("unload")),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("nextPlaybackAction", () => {
  it("pauses a playing sound regardless of position", () => {
    expect(
      nextPlaybackAction({ isPlaying: true, positionMillis: 0, durationMillis: 5000 }),
    ).toBe("pause");
    expect(
      nextPlaybackAction({
        isPlaying: true,
        positionMillis: 5000,
        durationMillis: 5000,
      }),
    ).toBe("pause");
  });

  it("resumes a paused sound parked mid-track", () => {
    expect(
      nextPlaybackAction({
        isPlaying: false,
        positionMillis: 2000,
        durationMillis: 5000,
      }),
    ).toBe("resume");
  });

  it("restarts once the position is within 100ms of the end", () => {
    // 4899 -> still resume, 4900 -> restart. Pins the boundary, so widening or
    // narrowing the 100ms window flips one of these.
    expect(
      nextPlaybackAction({
        isPlaying: false,
        positionMillis: 4899,
        durationMillis: 5000,
      }),
    ).toBe("resume");
    expect(
      nextPlaybackAction({
        isPlaying: false,
        positionMillis: 4900,
        durationMillis: 5000,
      }),
    ).toBe("restart");
    expect(
      nextPlaybackAction({
        isPlaying: false,
        positionMillis: 5000,
        durationMillis: 5000,
      }),
    ).toBe("restart");
  });

  it("treats an unknown duration as zero, so a fresh sound restarts", () => {
    expect(nextPlaybackAction({ isPlaying: false, positionMillis: 0 })).toBe(
      "restart",
    );
  });
});

describe("useNoteAudioPlayer", () => {
  it("loads the paired binary on the first tap and plays immediately", async () => {
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "file:///v/Audio/note.m4a",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("NOTE-MARKDOWN"));
    await act(async () => {
      await result.current.togglePlay();
    });

    expect(readPairedBinaryUri).toHaveBeenCalledWith("NOTE-MARKDOWN");
    const [source, options] = vi.mocked(Audio.Sound.createAsync).mock.calls[0];
    expect(source).toEqual({ uri: "file:///v/Audio/note.m4a" });
    expect(options).toMatchObject({ shouldPlay: true });
    expect(result.current.playerLoading).toBe(false);
    expect(result.current.playerError).toBeNull();
  });

  it("pushes status-callback updates into position/duration/playing state", async () => {
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    const onStatus = vi.mocked(Audio.Sound.createAsync).mock
      .calls[0][2] as unknown as StatusCallback;

    act(() => {
      onStatus({
        isLoaded: true,
        isPlaying: true,
        positionMillis: 1234,
        durationMillis: 9876,
      });
    });
    expect(result.current.isPlaying).toBe(true);
    expect(result.current.positionMs).toBe(1234);
    expect(result.current.durationMs).toBe(9876);

    // didJustFinish stops the button showing "pause" even though the status
    // frame that carries it still reports isPlaying.
    act(() => {
      onStatus({
        isLoaded: true,
        isPlaying: true,
        positionMillis: 9876,
        durationMillis: 9876,
        didJustFinish: true,
      });
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.positionMs).toBe(9876);
  });

  it("ignores an unloaded status frame", async () => {
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    const onStatus = vi.mocked(Audio.Sound.createAsync).mock
      .calls[0][2] as unknown as StatusCallback;
    act(() => {
      onStatus({ isLoaded: true, isPlaying: true, positionMillis: 500, durationMillis: 1 });
    });
    act(() => {
      onStatus({ isLoaded: false, positionMillis: 4242 });
    });
    expect(result.current.positionMs).toBe(500);
  });

  it("pauses on the second tap instead of re-loading", async () => {
    const sound = makeSound({
      isLoaded: true,
      isPlaying: true,
      positionMillis: 100,
      durationMillis: 5000,
    });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    await act(async () => {
      await result.current.togglePlay();
    });

    expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1);
    expect(readPairedBinaryUri).toHaveBeenCalledTimes(1);
    expect(sound.calls).toEqual(["pause"]);
  });

  it("rewinds before replaying a sound parked at the end", async () => {
    const sound = makeSound({
      isLoaded: true,
      isPlaying: false,
      positionMillis: 5000,
      durationMillis: 5000,
    });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    await act(async () => {
      await result.current.togglePlay();
    });

    // Order matters: seeking AFTER play would replay from the end.
    expect(sound.calls).toEqual(["seek:0", "play"]);
  });

  it("resumes in place from mid-track without seeking", async () => {
    const sound = makeSound({
      isLoaded: true,
      isPlaying: false,
      positionMillis: 2000,
      durationMillis: 5000,
    });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    await act(async () => {
      await result.current.togglePlay();
    });

    expect(sound.calls).toEqual(["play"]);
    expect(sound.setPositionAsync).not.toHaveBeenCalled();
  });

  it("surfaces a load failure as playerError and stops the spinner", async () => {
    vi.mocked(readPairedBinaryUri).mockRejectedValue(new Error("no binary"));

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });

    expect(result.current.playerError).toBe("no binary");
    expect(result.current.playerLoading).toBe(false);
    expect(Audio.Sound.createAsync).not.toHaveBeenCalled();
  });

  it("clears a previous error when the retry succeeds", async () => {
    vi.mocked(readPairedBinaryUri).mockRejectedValueOnce(new Error("no binary"));
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    expect(result.current.playerError).toBe("no binary");
    await act(async () => {
      await result.current.togglePlay();
    });
    expect(result.current.playerError).toBeNull();
  });

  it("unloads the sound on unmount", async () => {
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result, unmount } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    expect(sound.unloadAsync).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(sound.unloadAsync).toHaveBeenCalledTimes(1));
  });

  it("drops status updates that arrive after unmount", async () => {
    const sound = makeSound({ isLoaded: true, isPlaying: true, positionMillis: 0 });
    vi.mocked(readPairedBinaryUri).mockResolvedValue({
      uri: "u",
    } as Awaited<ReturnType<typeof readPairedBinaryUri>>);
    vi.mocked(Audio.Sound.createAsync).mockResolvedValue({
      sound,
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);

    const { result, unmount } = renderHook(() => useNoteAudioPlayer("md"));
    await act(async () => {
      await result.current.togglePlay();
    });
    const onStatus = vi.mocked(Audio.Sound.createAsync).mock
      .calls[0][2] as unknown as StatusCallback;
    unmount();
    // A late frame must not setState on an unmounted component.
    expect(() =>
      onStatus({
        isLoaded: true,
        isPlaying: true,
        positionMillis: 777,
        durationMillis: 999,
      }),
    ).not.toThrow();
    expect(result.current.positionMs).toBe(0);
  });
});
