import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock (same pattern as queue.test.ts) ──────────────

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
  clearDraft,
  isEmptyDraft,
  loadDraft,
  saveDraft,
} from "./captureDraft";

const IDEA_KEY = "carnet:capture_draft:v1:idea";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("captureDraft", () => {
  it("round-trips a draft per mode", async () => {
    await saveDraft("idea", { text: "half a thought", transcript: "", ocrText: "" });
    await saveDraft("journal", { text: "", transcript: "spoken words", ocrText: "" });

    const idea = await loadDraft("idea");
    expect(idea?.text).toBe("half a thought");
    expect(idea?.savedAt).toBeTypeOf("number");

    const journal = await loadDraft("journal");
    expect(journal?.transcript).toBe("spoken words");

    // Modes are isolated.
    expect(await loadDraft("person")).toBeNull();
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadDraft("idea")).toBeNull();
  });

  it("treats an all-whitespace draft as empty and removes the key", async () => {
    await saveDraft("idea", { text: "real", transcript: "", ocrText: "" });
    await saveDraft("idea", { text: "   \n", transcript: "", ocrText: "" });
    expect(_store.has(IDEA_KEY)).toBe(false);
    expect(await loadDraft("idea")).toBeNull();
  });

  it("returns null on corrupt stored JSON", async () => {
    _store.set(IDEA_KEY, "{not json");
    expect(await loadDraft("idea")).toBeNull();
  });

  it("returns null on schema-mismatched stored value", async () => {
    _store.set(IDEA_KEY, JSON.stringify({ body: "wrong shape" }));
    expect(await loadDraft("idea")).toBeNull();
  });

  it("clearDraft removes the stored draft", async () => {
    await saveDraft("person", { text: "ctx", transcript: "", ocrText: "ocr" });
    await clearDraft("person");
    expect(await loadDraft("person")).toBeNull();
  });

  it("isEmptyDraft checks all three fields", () => {
    expect(isEmptyDraft({ text: "", transcript: "", ocrText: "" })).toBe(true);
    expect(isEmptyDraft({ text: "", transcript: "", ocrText: "x" })).toBe(false);
  });
});
