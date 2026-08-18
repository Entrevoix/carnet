import { describe, expect, it, vi } from "vitest";

import { createForegroundDrainTrigger } from "./foregroundDrainTrigger";

describe("createForegroundDrainTrigger", () => {
  it("fires the drain once on a kick", async () => {
    const drain = vi.fn(async () => {});
    const trigger = createForegroundDrainTrigger(drain, 30_000, "test", () => 0);
    trigger.kick();
    await Promise.resolve();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("does not stack repeated kicks inside the throttle window", async () => {
    const drain = vi.fn(async () => {});
    let now = 0;
    const trigger = createForegroundDrainTrigger(drain, 30_000, "test", () => now);
    trigger.kick();
    now += 1_000;
    trigger.kick();
    now += 5_000;
    trigger.kick();
    await Promise.resolve();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("fires again once the throttle window has elapsed", async () => {
    const drain = vi.fn(async () => {});
    let now = 0;
    const trigger = createForegroundDrainTrigger(drain, 30_000, "test", () => now);
    trigger.kick();
    now += 30_000;
    trigger.kick();
    await Promise.resolve();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("is a cheap no-op when the underlying drain resolves with nothing to do", async () => {
    const drain = vi.fn(async () => undefined);
    const trigger = createForegroundDrainTrigger(drain, 30_000, "test", () => 0);
    trigger.kick();
    await Promise.resolve();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(1);
    // A second kick inside the window still doesn't call drain again — the
    // "no-op" cheapness comes from the wrapped drain's own contract
    // (single-flight + empty-queue-cheap), not from anything special here.
    trigger.kick();
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("never lets a rejected drain escape as an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const drain = vi.fn(async () => {
      throw new Error("boom");
    });
    const trigger = createForegroundDrainTrigger(drain, 30_000, "queue-test", () => 0);
    expect(() => trigger.kick()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn).toHaveBeenCalledWith(
      "[queue-test] drain failed:",
      "boom",
    );
    warn.mockRestore();
  });
});
