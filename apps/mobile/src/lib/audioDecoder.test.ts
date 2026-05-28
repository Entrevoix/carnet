import { beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as captureNotification.test.ts: vi.doMock + vi.resetModules
// before each test so we can switch Platform / NativeModules per-case
// without leaking state across tests.

function mockReactNative(opts: {
  osPlatform: "android" | "ios";
  hasNative: boolean;
  decodeResult?: string;
}): void {
  vi.doMock("react-native", () => {
    const decodeToWav = vi.fn().mockResolvedValue(opts.decodeResult ?? "out");
    const native = opts.hasNative ? { AudioDecoder: { decodeToWav } } : {};
    return {
      NativeModules: native,
      Platform: { OS: opts.osPlatform, Version: 33 },
    };
  });
}

beforeEach(() => {
  vi.resetModules();
});

describe("audioDecoder facade", () => {
  it("isAvailable() returns false on iOS even if an AudioDecoder module is present", async () => {
    mockReactNative({ osPlatform: "ios", hasNative: true });
    const mod = await import("./audioDecoder");
    expect(mod.isAvailable()).toBe(false);
  });

  it("isAvailable() returns false when the native module is missing (Expo Go path)", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./audioDecoder");
    expect(mod.isAvailable()).toBe(false);
  });

  it("isAvailable() returns true when the native module is registered on Android", async () => {
    mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./audioDecoder");
    expect(mod.isAvailable()).toBe(true);
  });

  it("decodeToWav() throws a friendly error when the native module is missing", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./audioDecoder");
    await expect(mod.decodeToWav("in.m4a", "out.wav")).rejects.toThrow(
      /not available/,
    );
  });

  it("decodeToWav() delegates to native.decodeToWav(inputUri, outputUri) on Android", async () => {
    mockReactNative({
      osPlatform: "android",
      hasNative: true,
      decodeResult: "file:///cache/decoded.wav",
    });
    const mod = await import("./audioDecoder");
    const out = await mod.decodeToWav(
      "file:///cache/input.m4a",
      "file:///cache/decoded.wav",
    );
    expect(out).toBe("file:///cache/decoded.wav");
    // Verify the native fn received the exact URIs we passed — pins the
    // contract so a future facade refactor can't silently swap argument
    // order or transform the URIs.
    const rn = await import("react-native");
    const nativeFn = (rn.NativeModules as Record<string, { decodeToWav: ReturnType<typeof vi.fn> }>)
      .AudioDecoder.decodeToWav;
    expect(nativeFn).toHaveBeenCalledWith(
      "file:///cache/input.m4a",
      "file:///cache/decoded.wav",
    );
  });
});
