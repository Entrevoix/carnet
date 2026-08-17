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

  /** Builds the YYYY-MM-DD string todayLocal is expected to produce for a
   * given Date, using that Date's own LOCAL getters. Implementation-
   * independent of the host's timezone — a hardcoded literal (e.g.
   * "2026-08-17") only discriminates a local-vs-UTC implementation bug on a
   * host with a negative UTC offset, and CI runners are commonly UTC. */
  function expectedLocalDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  it("formats using the local calendar date, whatever the host's timezone", () => {
    const fixture = new Date(2026, 7, 17, 23, 30, 0);
    vi.setSystemTime(fixture);
    expect(todayLocal()).toBe(expectedLocalDateString(fixture));
  });

  it("zero-pads single-digit months and days", () => {
    const fixture = new Date(2026, 0, 5, 12, 0, 0);
    vi.setSystemTime(fixture);
    expect(todayLocal()).toBe(expectedLocalDateString(fixture));
  });

  it("uses the LOCAL date, not the UTC date, right at the boundary where they differ", () => {
    // The two tests above hold todayLocal to whatever the host's own local
    // getters say — which would pass even if todayLocal quietly used the
    // UTC getters instead, since expectedLocalDateString would then be
    // "wrong" in the exact same way. This test picks an instant that
    // provably straddles the local/UTC day boundary for the host's ACTUAL
    // offset, so it fails if todayLocal reads UTC fields.
    const offsetMinutes = new Date().getTimezoneOffset();
    if (offsetMinutes === 0) {
      // Host is UTC (some CI runners) — local and UTC calendar dates can
      // never differ here, so there is no boundary to straddle. The other
      // two tests still pin todayLocal to the local getters.
      return;
    }
    // getTimezoneOffset() > 0 means the host is WEST of UTC (e.g. the
    // Americas): UTC = local + offset, so a late local time (23:59) rolls
    // into the next UTC day for any nonzero offset. A negative offset means
    // EAST of UTC: UTC = local - |offset|, so an early local time (00:01)
    // rolls into the PREVIOUS UTC day instead.
    const localInstant =
      offsetMinutes > 0
        ? new Date(2026, 7, 17, 23, 59, 0)
        : new Date(2026, 7, 17, 0, 1, 0);
    vi.setSystemTime(localInstant);
    const utcDateString = `${localInstant.getUTCFullYear()}-${String(
      localInstant.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(localInstant.getUTCDate()).padStart(2, "0")}`;

    expect(todayLocal()).not.toBe(utcDateString);
    expect(todayLocal()).toBe(expectedLocalDateString(localInstant));
  });
});
