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

import { recordCrash } from "../lib/crashLog";
import { carnetLight } from "../lib/theme";
import { DiagnosticsSection } from "./DiagnosticsSection";

function renderSection() {
  return render(
    <PaperProvider theme={carnetLight}>
      <DiagnosticsSection />
    </PaperProvider>,
  );
}

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("DiagnosticsSection", () => {
  it("shows 'No crashes recorded' when the log is empty", async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByText(/no crashes recorded/i)).toBeTruthy();
    });
  });

  it("shows a count and lets you copy the log", async () => {
    await recordCrash(new Error("boom"), { isFatal: true });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/1 crash recorded/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy log"));
    await waitFor(() => {
      expect(setStringAsync).toHaveBeenCalledTimes(1);
    });
    expect(setStringAsync.mock.calls[0][0]).toContain("boom");
  });

  it("shows a failure message when the clipboard write rejects", async () => {
    await recordCrash(new Error("boom"));
    setStringAsync.mockRejectedValueOnce(new Error("clipboard unavailable"));
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/1 crash recorded/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy log"));
    await waitFor(() => {
      expect(screen.getByText(/copy failed/i)).toBeTruthy();
    });
    expect(screen.queryByText(/copied to clipboard/i)).toBeNull();
  });

  it("pluralizes correctly for multiple crashes", async () => {
    await recordCrash(new Error("one"));
    await recordCrash(new Error("two"));
    renderSection();
    await waitFor(() => {
      expect(screen.getByText(/2 crashes recorded/i)).toBeTruthy();
    });
  });

  it("clears the log and updates the count", async () => {
    await recordCrash(new Error("boom"));
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/1 crash recorded/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Clear log"));

    await waitFor(() => {
      expect(screen.getByText(/no crashes recorded/i)).toBeTruthy();
    });
  });

  it("hides the stale 'Copied' confirmation after clearing the log", async () => {
    await recordCrash(new Error("boom"));
    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/1 crash recorded/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy log"));
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Clear log"));

    await waitFor(() => {
      expect(screen.getByText(/no crashes recorded/i)).toBeTruthy();
    });
    expect(screen.queryByText(/copied to clipboard/i)).toBeNull();
  });
});
