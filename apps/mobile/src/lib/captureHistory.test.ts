import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage", () => ({
  recordCapture: vi.fn(async () => {}),
  removeFromHistoryByFilepath: vi.fn(async () => {}),
}));

import { chainHistoryWrite } from "./captureHistory";
import { recordCapture, removeFromHistoryByFilepath } from "./storage";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chainHistoryWrite", () => {
  it("records the new entry directly when there is no prior write and it isn't a resume", async () => {
    await chainHistoryWrite({
      priorWrite: null,
      resuming: false,
      filepath: "file:///v/Ideas/my-idea.md",
      mode: "idea",
      title: "My Idea",
      id: "abc",
      createdAt: 1,
    });

    expect(removeFromHistoryByFilepath).not.toHaveBeenCalled();
    expect(recordCapture).toHaveBeenCalledWith({
      id: "abc",
      mode: "idea",
      title: "My Idea",
      filepath: "file:///v/Ideas/my-idea.md",
      createdAt: 1,
    });
  });

  it("removes the stale history row by filepath first when resuming", async () => {
    await chainHistoryWrite({
      priorWrite: null,
      resuming: true,
      filepath: "file:///v/Ideas/my-idea.md",
      mode: "idea",
      title: "My Edited Idea",
      id: "def",
      createdAt: 2,
    });

    expect(removeFromHistoryByFilepath).toHaveBeenCalledWith(
      "file:///v/Ideas/my-idea.md",
    );
    expect(recordCapture).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Edited Idea", id: "def" }),
    );
    // Order: the stale row must be gone before the fresh one lands.
    const removeOrder = vi.mocked(removeFromHistoryByFilepath).mock.invocationCallOrder[0];
    const recordOrder = vi.mocked(recordCapture).mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(recordOrder);
  });

  it("waits for the prior write to settle before starting its own mutation", async () => {
    const order: string[] = [];
    let resolvePrior!: () => void;
    const prior = new Promise<void>((res) => {
      resolvePrior = res;
    });
    vi.mocked(recordCapture).mockImplementation(async () => {
      order.push("record");
    });

    const p = chainHistoryWrite({
      priorWrite: prior,
      resuming: false,
      filepath: "file:///v/Ideas/second.md",
      mode: "idea",
      title: "Second",
      id: "ghi",
      createdAt: 3,
    });

    // Nothing has happened yet — still awaiting the prior chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(recordCapture).not.toHaveBeenCalled();

    order.push("prior-resolved");
    resolvePrior();
    await p;

    expect(order).toEqual(["prior-resolved", "record"]);
  });

  it("propagates a failure from the underlying storage call", async () => {
    vi.mocked(recordCapture).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      chainHistoryWrite({
        priorWrite: null,
        resuming: false,
        filepath: "file:///v/Ideas/x.md",
        mode: "idea",
        title: "X",
        id: "id",
        createdAt: 0,
      }),
    ).rejects.toThrow("disk full");
  });
});
