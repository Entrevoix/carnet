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

  it("lets a fatal crash's write land before chaining to the default handler", async () => {
    // The app is torn down as soon as the default handler runs, so an
    // unawaited write would race the teardown — losing exactly the crashes
    // the log exists to preserve.
    vi.resetModules();
    const { installGlobalCrashHandler } = await import("./crashReporting");
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;

    let releaseWrite!: () => void;
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => resolve();
        }),
    );

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

    installedHandler(new Error("fatal boom"), true);
    await flushMicrotasks();
    expect(previousHandler).not.toHaveBeenCalled();

    releaseWrite();
    await flushMicrotasks();
    expect(previousHandler).toHaveBeenCalledTimes(1);
  });

  it("does not delay the default handler for a non-fatal error", async () => {
    vi.resetModules();
    const { installGlobalCrashHandler } = await import("./crashReporting");
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;
    // A write that never settles — the non-fatal path must not wait on it.
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );

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

    installedHandler(new Error("non-fatal boom"), false);
    expect(previousHandler).toHaveBeenCalledTimes(1);
  });

  it("still runs the default handler when a fatal write hangs past the timeout", async () => {
    vi.resetModules();
    const { installGlobalCrashHandler, FATAL_FLUSH_TIMEOUT_MS } = await import(
      "./crashReporting"
    );
    const AsyncStorage = (await import("@react-native-async-storage/async-storage"))
      .default;
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );

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

    installedHandler(new Error("fatal boom"), true);
    await new Promise((resolve) => setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS + 20));
    expect(previousHandler).toHaveBeenCalledTimes(1);
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
