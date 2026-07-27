import { beforeEach, describe, expect, it, vi } from "vitest";

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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
  delete (global as unknown as { ErrorUtils?: unknown }).ErrorUtils;
});

describe("installGlobalCrashHandler", () => {
  it("does nothing when global.ErrorUtils is unavailable (e.g. test/web env)", async () => {
    vi.resetModules();
    const { installGlobalCrashHandler } = await import("./crashReporting");
    expect(() => installGlobalCrashHandler()).not.toThrow();
  });

  it("wraps the existing global handler, recording the crash then chaining to it", async () => {
    vi.resetModules();
    const { installGlobalCrashHandler } = await import("./crashReporting");
    const { getCrashLog } = await import("./crashLog");

    const previousHandler = vi.fn();
    const errorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: vi.fn((handler: (error: unknown, isFatal: boolean) => void) => {
        (errorUtils as unknown as { __handler: unknown }).__handler = handler;
      }),
    };
    (global as unknown as { ErrorUtils: unknown }).ErrorUtils = errorUtils;

    installGlobalCrashHandler();

    const installedHandler = (
      errorUtils as unknown as {
        __handler: (error: unknown, isFatal: boolean) => void;
      }
    ).__handler;

    const err = new Error("fatal boom");
    installedHandler(err, true);
    await flushMicrotasks();

    expect(previousHandler).toHaveBeenCalledWith(err, true);
    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ message: "fatal boom", isFatal: true });
  });

  it("is idempotent — calling it twice does not install a second handler", async () => {
    vi.resetModules();
    const { installGlobalCrashHandler } = await import("./crashReporting");

    const setGlobalHandler = vi.fn();
    (global as unknown as { ErrorUtils: unknown }).ErrorUtils = {
      getGlobalHandler: () => undefined,
      setGlobalHandler,
    };

    installGlobalCrashHandler();
    installGlobalCrashHandler();

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
  });
});
