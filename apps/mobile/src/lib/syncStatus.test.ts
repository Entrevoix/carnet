import { describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({
  getQueueCounts: vi.fn(async () => ({ pending: 2, failed: 1 })),
}));

import { deriveSyncStatus, getSyncStatus } from "./syncStatus";

describe("deriveSyncStatus", () => {
  it("is idle with an empty queue", () => {
    const s = deriveSyncStatus(0, 0);
    expect(s.state).toBe("idle");
    expect(s.detail).toMatch(/enriched/);
  });

  it("is pending when rows await retry", () => {
    const s = deriveSyncStatus(3, 0);
    expect(s.state).toBe("pending");
    expect(s.pending).toBe(3);
    expect(s.detail).toMatch(/3 captures waiting/);
  });

  it("uses singular copy for one pending capture", () => {
    expect(deriveSyncStatus(1, 0).detail).toMatch(/1 capture waiting/);
  });

  it("error wins over pending", () => {
    const s = deriveSyncStatus(2, 1);
    expect(s.state).toBe("error");
    expect(s.pending).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.detail).toMatch(/1 capture couldn't be enriched/);
  });
});

describe("getSyncStatus", () => {
  it("derives from queue counts", async () => {
    const s = await getSyncStatus();
    expect(s.state).toBe("error");
    expect(s.pending).toBe(2);
    expect(s.failed).toBe(1);
  });
});
