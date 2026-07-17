import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLD_START_BUDGET_MS,
  isColdStartBreach,
  reportColdStart,
  _resetColdStartForTests,
} from "./startupTiming";

beforeEach(() => {
  _resetColdStartForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isColdStartBreach", () => {
  it("breaches strictly above the budget", () => {
    expect(isColdStartBreach(COLD_START_BUDGET_MS, COLD_START_BUDGET_MS)).toBe(false);
    expect(isColdStartBreach(COLD_START_BUDGET_MS + 1, COLD_START_BUDGET_MS)).toBe(true);
  });
});

describe("reportColdStart", () => {
  it("returns the elapsed time and stays quiet within budget", () => {
    expect(reportColdStart(1_000, 2_200, 3_000)).toBe(1_200);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns loudly on a budget breach, naming the numbers", () => {
    expect(reportColdStart(1_000, 5_500, 3_000)).toBe(4_500);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(console.warn).mock.calls[0][0] as string;
    expect(msg).toContain("[startup]");
    expect(msg).toContain("4500ms");
    expect(msg).toContain("3000ms");
  });

  it("reports once per process — re-mounts and Home revisits are no-ops", () => {
    expect(reportColdStart(1_000, 2_000, 3_000)).toBe(1_000);
    expect(reportColdStart(1_000, 9_999, 3_000)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
