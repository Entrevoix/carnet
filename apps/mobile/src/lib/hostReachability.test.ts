import { afterEach, describe, expect, it, vi } from "vitest";

import { isHostReachable } from "./hostReachability";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(impl: typeof fetch): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("isHostReachable", () => {
  it("returns true on a 200 response", async () => {
    mockFetch(async () => new Response("ok", { status: 200 }));
    await expect(isHostReachable("http://192.168.1.5:3000")).resolves.toBe(true);
  });

  it("treats ANY http response as reachable — 401/404/405 are answers", async () => {
    for (const status of [401, 404, 405, 500]) {
      mockFetch(async () => new Response("nope", { status }));
      await expect(isHostReachable("https://kk.tailnet.ts.net")).resolves.toBe(
        true,
      );
    }
  });

  it("returns false on a network-level failure (DNS/refused/VPN down)", async () => {
    mockFetch(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(isHostReachable("https://kk.tailnet.ts.net")).resolves.toBe(
      false,
    );
  });

  it("returns false when the probe times out (abort fires)", async () => {
    // A hanging server: never resolves on its own, rejects when aborted.
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("Aborted")),
          );
        }) as Promise<Response>,
    );
    await expect(
      isHostReachable("https://kk.tailnet.ts.net", 25),
    ).resolves.toBe(false);
  });

  it("returns false for a blank URL without touching the network", async () => {
    const fn = mockFetch(async () => new Response("ok"));
    await expect(isHostReachable("   ")).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("probes with HEAD", async () => {
    const fn = mockFetch(async () => new Response("ok"));
    await isHostReachable("https://kk.tailnet.ts.net");
    expect(fn).toHaveBeenCalledWith(
      "https://kk.tailnet.ts.net",
      expect.objectContaining({ method: "HEAD" }),
    );
  });
});
