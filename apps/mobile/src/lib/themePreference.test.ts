import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock ───────────────────────────────────────────────
// Same pattern as queue.test.ts / storage.test.ts.

const _store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getThemePreference,
  setThemePreference,
} from "./themePreference";

const KEY = "carnet:theme_preference:v1";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("themePreference", () => {
  it("defaults to system when nothing is stored", async () => {
    expect(await getThemePreference()).toBe("system");
  });

  it("round-trips light and dark", async () => {
    await setThemePreference("dark");
    expect(await getThemePreference()).toBe("dark");
    await setThemePreference("light");
    expect(await getThemePreference()).toBe("light");
  });

  it("persists under a versioned key", async () => {
    await setThemePreference("dark");
    expect(_store.get(KEY)).toBe("dark");
  });

  it("falls back to system on a corrupt stored value", async () => {
    _store.set(KEY, "sepia");
    expect(await getThemePreference()).toBe("system");
  });

  it("falls back to system when storage read rejects", async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    expect(await getThemePreference()).toBe("system");
  });
});
