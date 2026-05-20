import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage mock — same pattern as writer.test.ts's
// expo-file-system mock, but for the React Native AsyncStorage module.
// We can't pull in the real native binding under Node + vitest.
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

import {
  getRecentCaptures,
  recordCapture,
  removeFromHistory,
  type CaptureEntry,
} from "./storage";

function entry(id: string, t = Date.now()): CaptureEntry {
  return {
    id,
    mode: "idea",
    title: `entry-${id}`,
    filepath: `/vault/Ideas/${id}.md`,
    createdAt: t,
  };
}

describe("recents history", () => {
  beforeEach(() => {
    _store.clear();
  });

  it("starts empty when nothing has been recorded", async () => {
    expect(await getRecentCaptures()).toEqual([]);
  });

  it("records entries in MRU order (newest first)", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("caps at HISTORY_LIMIT (20)", async () => {
    for (let i = 0; i < 25; i++) {
      await recordCapture(entry(`${i}`));
    }
    const xs = await getRecentCaptures();
    expect(xs).toHaveLength(20);
    expect(xs[0].id).toBe("24");
    expect(xs[19].id).toBe("5");
  });

  it("removeFromHistory removes by id and preserves the order of the rest", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    await removeFromHistory("b");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("removeFromHistory is a no-op for an unknown id", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await removeFromHistory("nonexistent");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("removeFromHistory on an empty store does not throw", async () => {
    await expect(removeFromHistory("anything")).resolves.toBeUndefined();
    expect(await getRecentCaptures()).toEqual([]);
  });

  it("returns an empty array when stored JSON is corrupted", async () => {
    _store.set("carnet:history:v1", "{ this is not valid JSON");
    expect(await getRecentCaptures()).toEqual([]);
  });
});
