// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

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

const setStringAsync = vi.fn(async (_s: string) => undefined);
vi.mock("expo-clipboard", () => ({
  setStringAsync: (s: string) => setStringAsync(s),
}));

import { getCrashLog } from "../lib/crashLog";
import { carnetLight } from "../lib/theme";
import { CrashBoundary } from "./CrashBoundary";

function Bomb(): never {
  throw new Error("kaboom");
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("CrashBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <div>fine</div>
        </CrashBoundary>
      </PaperProvider>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("catches a render error, shows the fallback, and records it to the crash log", async () => {
    // React logs the caught error to the console by default — silence it
    // for this test's expected-error case.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <Bomb />
        </CrashBoundary>
      </PaperProvider>,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();

    await flushMicrotasks();
    const log = await getCrashLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ message: "kaboom", isFatal: false });

    consoleError.mockRestore();
  });

  it("copies the error details from the fallback itself", async () => {
    // Settings → Diagnostics is unreachable while the boundary is tripped —
    // it replaces the whole navigation tree — so this is the only escape
    // hatch for a crash that reproduces on every retry.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <Bomb />
        </CrashBoundary>
      </PaperProvider>,
    );

    fireEvent.click(screen.getByText("Copy error details"));
    await waitFor(() => {
      expect(setStringAsync).toHaveBeenCalledTimes(1);
    });
    expect(setStringAsync.mock.calls[0][0]).toContain("kaboom");
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeTruthy();
    });

    consoleError.mockRestore();
  });

  it("surfaces a clipboard failure in the fallback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setStringAsync.mockRejectedValueOnce(new Error("clipboard unavailable"));

    render(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <Bomb />
        </CrashBoundary>
      </PaperProvider>,
    );

    fireEvent.click(screen.getByText("Copy error details"));
    await waitFor(() => {
      expect(screen.getByText("Copy failed")).toBeTruthy();
    });

    consoleError.mockRestore();
  });

  it("'Try again' resets the boundary state", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    function MaybeBomb() {
      if (shouldThrow) throw new Error("kaboom");
      return <div>recovered</div>;
    }

    const { rerender } = render(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <MaybeBomb />
        </CrashBoundary>
      </PaperProvider>,
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Try again"));
    rerender(
      <PaperProvider theme={carnetLight}>
        <CrashBoundary>
          <MaybeBomb />
        </CrashBoundary>
      </PaperProvider>,
    );

    expect(screen.getByText("recovered")).toBeTruthy();
    consoleError.mockRestore();
  });
});
