import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localId, todayLocal } from "./captureLocalIds";

describe("localId", () => {
  it("returns a non-empty string", () => {
    expect(localId().length).toBeGreaterThan(0);
  });

  it("returns different values on successive calls", () => {
    const a = localId();
    const b = localId();
    expect(a).not.toBe(b);
  });
});

describe("todayLocal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats as local YYYY-MM-DD, not UTC", () => {
    // 2026-08-17T23:30 in UTC-5 is still 2026-08-17 local, but would already
    // be 2026-08-18 in UTC — the whole point of using local getters.
    vi.setSystemTime(new Date(2026, 7, 17, 23, 30, 0));
    expect(todayLocal()).toBe("2026-08-17");
  });

  it("zero-pads single-digit months and days", () => {
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0));
    expect(todayLocal()).toBe("2026-01-05");
  });
});
