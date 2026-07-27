import { beforeEach, describe, expect, it, vi } from "vitest";

// Same in-memory AsyncStorage mock pattern as storage.test.ts.
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
  CRASH_LOG_LIMIT,
  clearCrashLog,
  getCrashLog,
  recordCrash,
} from "./crashLog";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("recordCrash / getCrashLog", () => {
  it("returns an empty log when nothing has been recorded", async () => {
    expect(await getCrashLog()).toEqual([]);
  });

  it("records an Error with message and stack", async () => {
    const err = new Error("boom");
    await recordCrash(err, { isFatal: true });

    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      message: "boom",
      isFatal: true,
    });
    expect(log[0].stack).toBeTruthy();
    expect(typeof log[0].timestamp).toBe("number");
    expect(typeof log[0].id).toBe("string");
  });

  it("normalizes a non-Error thrown value into a string message", async () => {
    await recordCrash("just a string", { isFatal: false });
    const log = await getCrashLog();
    expect(log[0].message).toBe("just a string");
    expect(log[0].stack).toBeUndefined();
    expect(log[0].isFatal).toBe(false);
  });

  it("defaults isFatal to false when not provided", async () => {
    await recordCrash(new Error("x"));
    const log = await getCrashLog();
    expect(log[0].isFatal).toBe(false);
  });

  it("prepends newest-first", async () => {
    await recordCrash(new Error("first"));
    await recordCrash(new Error("second"));
    const log = await getCrashLog();
    expect(log.map((c) => c.message)).toEqual(["second", "first"]);
  });

  it("does not drop a record when two crashes fire concurrently (unawaited)", async () => {
    // Regression test: recordCrash used to do an unserialized read-modify-
    // write, so two concurrent calls could both read the same `existing`
    // array and the second write would clobber the first.
    await Promise.all([
      recordCrash(new Error("concurrent-a")),
      recordCrash(new Error("concurrent-b")),
    ]);
    const log = await getCrashLog();
    expect(log.map((c) => c.message).sort()).toEqual(["concurrent-a", "concurrent-b"]);
  });

  it("caps the log at CRASH_LOG_LIMIT entries, dropping the oldest", async () => {
    for (let i = 0; i < CRASH_LOG_LIMIT + 5; i++) {
      await recordCrash(new Error(`crash-${i}`));
    }
    const log = await getCrashLog();
    expect(log).toHaveLength(CRASH_LOG_LIMIT);
    // Newest first — the most recent CRASH_LOG_LIMIT crashes survive.
    expect(log[0].message).toBe(`crash-${CRASH_LOG_LIMIT + 4}`);
    expect(log[log.length - 1].message).toBe("crash-5");
  });

  it("never throws even when AsyncStorage.setItem rejects", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("disk full"));
    await expect(recordCrash(new Error("boom"))).resolves.toBeUndefined();
  });

  it("never throws even when AsyncStorage.getItem rejects mid-record", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("disk error"));
    await expect(recordCrash(new Error("boom"))).resolves.toBeUndefined();
  });

  it("getCrashLog returns [] (not throws) on corrupt stored JSON", async () => {
    _store.set("carnet:crashlog:v1", "not json");
    expect(await getCrashLog()).toEqual([]);
  });
});

describe("clearCrashLog", () => {
  it("empties a populated log", async () => {
    await recordCrash(new Error("one"));
    await recordCrash(new Error("two"));
    expect(await getCrashLog()).toHaveLength(2);

    await clearCrashLog();
    expect(await getCrashLog()).toEqual([]);
  });

  it("is a no-op on an already-empty log", async () => {
    await expect(clearCrashLog()).resolves.toBeUndefined();
    expect(await getCrashLog()).toEqual([]);
  });
});
