// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage mock — same pattern as queue.test.ts (no native
// binding under Node).
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

import {
  assetKey,
  clearPushedAssetKeys,
  loadPushedAssetKeys,
  savePushedAssetKeys,
} from "./karakeepAssetSync";
import AsyncStorage from "@react-native-async-storage/async-storage";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("assetKey", () => {
  it("joins subdir and filename into a stable key", () => {
    expect(assetKey("Photos", "a.jpg")).toBe("Photos/a.jpg");
    expect(assetKey("Files", "report.pdf")).toBe("Files/report.pdf");
  });
});

describe("loadPushedAssetKeys / savePushedAssetKeys", () => {
  it("returns an empty set when nothing was saved", async () => {
    expect(await loadPushedAssetKeys("bk_1")).toEqual(new Set());
  });

  it("round-trips a saved set", async () => {
    await savePushedAssetKeys("bk_1", ["Photos/a.jpg", "Files/b.pdf"]);
    expect(await loadPushedAssetKeys("bk_1")).toEqual(
      new Set(["Photos/a.jpg", "Files/b.pdf"]),
    );
  });

  it("accepts a Set as input and persists it as a JSON array", async () => {
    await savePushedAssetKeys("bk_1", new Set(["Photos/a.jpg"]));
    expect(_store.get("carnet:karakeep-assets:v1:bk_1")).toBe('["Photos/a.jpg"]');
  });

  it("scopes keys per bookmark id", async () => {
    await savePushedAssetKeys("bk_1", ["Photos/a.jpg"]);
    await savePushedAssetKeys("bk_2", ["Files/b.pdf"]);
    expect(await loadPushedAssetKeys("bk_1")).toEqual(new Set(["Photos/a.jpg"]));
    expect(await loadPushedAssetKeys("bk_2")).toEqual(new Set(["Files/b.pdf"]));
  });

  it("returns an empty set on a corrupt (non-JSON) value", async () => {
    await AsyncStorage.setItem("carnet:karakeep-assets:v1:bk_x", "{not json");
    expect(await loadPushedAssetKeys("bk_x")).toEqual(new Set());
  });

  it("returns an empty set when the stored value is not an array", async () => {
    await AsyncStorage.setItem(
      "carnet:karakeep-assets:v1:bk_y",
      JSON.stringify({ a: 1 }),
    );
    expect(await loadPushedAssetKeys("bk_y")).toEqual(new Set());
  });

  it("ignores non-string entries in a stored array", async () => {
    await AsyncStorage.setItem(
      "carnet:karakeep-assets:v1:bk_z",
      JSON.stringify(["Photos/a.jpg", 42, null, "Files/b.pdf"]),
    );
    expect(await loadPushedAssetKeys("bk_z")).toEqual(
      new Set(["Photos/a.jpg", "Files/b.pdf"]),
    );
  });
});

describe("clearPushedAssetKeys", () => {
  it("forgets a bookmark's record, so a later load is empty", async () => {
    await savePushedAssetKeys("bk_1", ["Photos/a.jpg"]);
    await clearPushedAssetKeys("bk_1");
    expect(await loadPushedAssetKeys("bk_1")).toEqual(new Set());
  });

  it("leaves other bookmarks' records intact", async () => {
    await savePushedAssetKeys("bk_1", ["Photos/a.jpg"]);
    await savePushedAssetKeys("bk_2", ["Files/b.pdf"]);
    await clearPushedAssetKeys("bk_1");
    expect(await loadPushedAssetKeys("bk_2")).toEqual(new Set(["Files/b.pdf"]));
  });
});
