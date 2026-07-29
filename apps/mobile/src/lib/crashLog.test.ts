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
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
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

  it("never throws even when the error's own toString() throws", async () => {
    const hostile = {
      toString() {
        throw new Error("poisoned toString");
      },
    };
    await expect(recordCrash(hostile)).resolves.toBeUndefined();
    // Record construction failed before it could be queued — log stays
    // empty, which is correct "best-effort, never throws" behavior, not
    // silent corruption of a partially-built record.
    expect(await getCrashLog()).toEqual([]);
  });

  it("a poisoned-toString failure does not block later crashes from being recorded", async () => {
    const hostile = {
      toString() {
        throw new Error("poisoned toString");
      },
    };
    await recordCrash(hostile);
    await recordCrash(new Error("recorded fine"));
    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe("recorded fine");
  });

  it("truncates an oversized message so one record can't blow the storage budget", async () => {
    await recordCrash(new Error("x".repeat(MAX_MESSAGE_CHARS * 3)));
    const log = await getCrashLog();
    expect(log[0].message.length).toBeLessThan(MAX_MESSAGE_CHARS + 32);
    expect(log[0].message).toMatch(/\[truncated\]$/);
  });

  it("truncates an oversized stack", async () => {
    const err = new Error("boom");
    err.stack = "y".repeat(MAX_STACK_CHARS * 2);
    await recordCrash(err);
    const log = await getCrashLog();
    expect(log[0].stack!.length).toBeLessThan(MAX_STACK_CHARS + 32);
    expect(log[0].stack).toMatch(/\[truncated\]$/);
  });

  it("leaves a message shorter than the cap untouched", async () => {
    await recordCrash(new Error("short"));
    const log = await getCrashLog();
    expect(log[0].message).toBe("short");
  });

  it("collapses a consecutive repeat into a count instead of a new entry", async () => {
    const makeErr = () => {
      const e = new Error("same boom");
      e.stack = "identical stack";
      return e;
    };
    await recordCrash(makeErr());
    await recordCrash(makeErr());
    await recordCrash(makeErr());

    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ message: "same boom", count: 3 });
  });

  it("does not let a repeated crash evict distinct earlier history", async () => {
    await recordCrash(new Error("distinct-one"));
    await recordCrash(new Error("distinct-two"));
    const repeat = () => {
      const e = new Error("repeating");
      e.stack = "same stack";
      return e;
    };
    for (let i = 0; i < CRASH_LOG_LIMIT + 10; i++) {
      await recordCrash(repeat());
    }

    const log = await getCrashLog();
    expect(log).toHaveLength(3);
    expect(log.map((c) => c.message)).toEqual([
      "repeating",
      "distinct-two",
      "distinct-one",
    ]);
    expect(log[0].count).toBe(CRASH_LOG_LIMIT + 10);
  });

  it("starts a new entry when a different crash interrupts a repeat run", async () => {
    const at = (message: string, stack: string) => {
      const e = new Error(message);
      e.stack = stack;
      return e;
    };
    await recordCrash(at("a", "stack-a"));
    await recordCrash(at("a", "stack-a"));
    await recordCrash(at("b", "stack-b"));
    await recordCrash(at("a", "stack-a"));

    const log = await getCrashLog();
    expect(log.map((c) => c.message)).toEqual(["a", "b", "a"]);
    expect(log[2].count).toBe(2);
  });

  it("treats same-message crashes from different throw sites as distinct", async () => {
    // Collapsing keys on message *and* stack — two unrelated failures that
    // happen to share a message must not be merged into one counted entry.
    const first = new Error("failed to write");
    first.stack = "at writer.ts:10";
    const second = new Error("failed to write");
    second.stack = "at queue.ts:42";

    await recordCrash(first);
    await recordCrash(second);

    const log = await getCrashLog();
    expect(log).toHaveLength(2);
    expect(log.every((c) => c.count === undefined)).toBe(true);
  });

  it("keeps the write queue usable after a failed write", async () => {
    // Regression guard for the inner try/catch: a rejected setItem must not
    // poison writeQueue for every crash recorded afterward.
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("disk full"));

    await recordCrash(new Error("lost to the failed write"));
    await recordCrash(new Error("recorded after the failure"));

    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe("recorded after the failure");
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
