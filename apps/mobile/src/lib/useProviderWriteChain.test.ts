// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

const getSettings = vi.fn();
const savePersistedOnly = vi.fn();
vi.mock("./settings", () => ({
  getSettings: (...args: unknown[]) => getSettings(...args),
  savePersistedOnly: (...args: unknown[]) => savePersistedOnly(...args),
}));

import { useProviderWriteChain } from "./useProviderWriteChain";

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    llmProviders: [],
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    ...overrides,
  };
}

beforeEach(() => {
  getSettings.mockReset();
  savePersistedOnly.mockReset();
});

describe("useProviderWriteChain", () => {
  it("two interleaved writes BOTH land — the second reads the first's already-persisted result", async () => {
    // Regression test for the CRITICAL lost-update finding. `stored` is a
    // stateful stand-in for the real settings blob: getSettings/
    // savePersistedOnly share it, with an artificial delay on the write, so
    // an unchained implementation would visibly interleave read → read →
    // write → write and the second write would clobber the first's change.
    let stored = baseSettings();
    getSettings.mockImplementation(async () => stored);
    savePersistedOnly.mockImplementation(async (s: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = s as ReturnType<typeof baseSettings>;
    });

    const { result } = renderHook(() => useProviderWriteChain());

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.persistIdentity({ activeProviderId: "relais" });
      p2 = result.current.persistIdentity({ fallbackProviderId: "omniroute" });
    });
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(stored.activeProviderId).toBe("relais");
    expect(stored.fallbackProviderId).toBe("omniroute");
  });

  it("writing is true while a write is in flight and false once it settles", async () => {
    let resolveWrite: () => void = () => undefined;
    getSettings.mockResolvedValue(baseSettings());
    savePersistedOnly.mockImplementation(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );

    const { result } = renderHook(() => useProviderWriteChain());
    expect(result.current.writing).toBe(false);

    act(() => {
      void result.current.persistIdentity({ activeProviderId: "relais" });
    });
    await waitFor(() => expect(result.current.writing).toBe(true));

    await act(async () => {
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.writing).toBe(false));
  });

  it("a rejected write does not wedge the chain for the next queued write", async () => {
    let stored = baseSettings();
    getSettings.mockImplementation(async () => stored);
    savePersistedOnly
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementation(async (s: unknown) => {
        stored = s as ReturnType<typeof baseSettings>;
      });

    const { result } = renderHook(() => useProviderWriteChain());

    let firstRejected = false;
    await act(async () => {
      await result.current
        .persistIdentity({ activeProviderId: "relais" })
        .catch(() => {
          firstRejected = true;
        });
    });
    expect(firstRejected).toBe(true);

    await act(async () => {
      await result.current.persistIdentity({ fallbackProviderId: "openai" });
    });
    expect(stored.fallbackProviderId).toBe("openai");
  });
});
