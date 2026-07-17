import { describe, expect, it } from "vitest";

import { createLock, localId, sanitizeError } from "./asyncQueueUtils";

describe("createLock", () => {
  it("serializes read-modify-write critical sections", async () => {
    const withLock = createLock();
    const order: string[] = [];
    let store = 0;

    const slowIncrement = withLock(async () => {
      const read = store;
      order.push("a-read");
      await new Promise((r) => setTimeout(r, 20));
      store = read + 1;
      order.push("a-write");
    });
    const fastIncrement = withLock(async () => {
      const read = store;
      order.push("b-read");
      store = read + 1;
      order.push("b-write");
    });

    await Promise.all([slowIncrement, fastIncrement]);
    // Without the lock, b reads before a writes and an increment is lost.
    expect(store).toBe(2);
    expect(order).toEqual(["a-read", "a-write", "b-read", "b-write"]);
  });

  it("keeps the chain alive after a rejected section", async () => {
    const withLock = createLock();
    await expect(
      withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withLock(async () => "still works")).resolves.toBe(
      "still works",
    );
  });

  it("gives each createLock() call an independent chain", async () => {
    const lockA = createLock();
    const lockB = createLock();
    let released = false;
    // Hold lock A open…
    const holdA = lockA(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            released = true;
            r();
          }, 30),
        ),
    );
    // …lock B must not wait on it.
    await lockB(async () => {
      expect(released).toBe(false);
    });
    await holdA;
  });
});

describe("localId", () => {
  it("produces distinct ids across rapid calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => localId()));
    expect(ids.size).toBe(100);
  });
});

describe("sanitizeError", () => {
  it("redacts Bearer tokens and Authorization headers", () => {
    expect(sanitizeError("failed: Bearer sk-abc.123-x/y= end")).toBe(
      "failed: Bearer [redacted] end",
    );
    expect(sanitizeError("hdr Authorization: token123; rest")).toBe(
      "hdr Authorization: [redacted]; rest",
    );
  });

  it("leaves token-free strings untouched", () => {
    expect(sanitizeError("HTTP 500 from server")).toBe("HTTP 500 from server");
  });
});
