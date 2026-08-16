import { describe, expect, it } from "vitest";

import {
  filterAndSplitModels,
  resolveBrowseApiKey,
  RECOMMENDED_MODELS as RECOMMENDED,
} from "./modelBrowser";

describe("filterAndSplitModels", () => {
  it("returns empty partitions when the catalog is null", () => {
    expect(filterAndSplitModels(null, "", RECOMMENDED)).toEqual({
      recommended: [],
      others: [],
    });
  });

  it("splits recommended (in RECOMMENDED order) from the rest with no filter", () => {
    const models = [
      "openai/gpt-4o-mini",
      "claude/claude-sonnet-4-6",
      "gemini/gemini-2.5-flash",
      "mistral/mixtral",
    ];
    expect(filterAndSplitModels(models, "", RECOMMENDED)).toEqual({
      recommended: ["gemini/gemini-2.5-flash", "claude/claude-sonnet-4-6"],
      others: ["openai/gpt-4o-mini", "mistral/mixtral"],
    });
  });

  it("preserves the RECOMMENDED list order, not the catalog order", () => {
    const models = [
      "claude/claude-sonnet-4-6",
      "gemini/gemini-2.5-flash-lite",
    ];
    const { recommended } = filterAndSplitModels(models, "", RECOMMENDED);
    expect(recommended).toEqual([
      "gemini/gemini-2.5-flash-lite",
      "claude/claude-sonnet-4-6",
    ]);
  });

  it("filters case-insensitively against both partitions", () => {
    const models = [
      "openai/gpt-4o-mini",
      "claude/claude-sonnet-4-6",
      "gemini/gemini-2.5-flash",
    ];
    expect(filterAndSplitModels(models, "CLAUDE", RECOMMENDED)).toEqual({
      recommended: ["claude/claude-sonnet-4-6"],
      others: [],
    });
  });

  it("trims surrounding whitespace from the filter", () => {
    const models = ["openai/gpt-4o-mini", "mistral/mixtral"];
    expect(filterAndSplitModels(models, "  mistral  ", RECOMMENDED)).toEqual({
      recommended: [],
      others: ["mistral/mixtral"],
    });
  });

  it("treats a whitespace-only filter as no filter", () => {
    const models = ["openai/gpt-4o-mini", "mistral/mixtral"];
    expect(filterAndSplitModels(models, "   ", RECOMMENDED)).toEqual({
      recommended: [],
      others: ["openai/gpt-4o-mini", "mistral/mixtral"],
    });
  });

  it("keeps a recommended model out of others (no double-listing)", () => {
    const models = ["claude/claude-sonnet-4-6", "openai/gpt-4o-mini"];
    const { recommended, others } = filterAndSplitModels(
      models,
      "",
      RECOMMENDED,
    );
    expect(recommended).toContain("claude/claude-sonnet-4-6");
    expect(others).not.toContain("claude/claude-sonnet-4-6");
  });

  // The browser renders `others` through a FlatList keyed on the model id
  // (components/ModelBrowserModal.tsx), so a duplicate id is a duplicate React
  // key: the list remounts cells and visibly pulses instead of settling.
  // llm.grepon.cc really does serve repeated ids (4 of them as of 2026-08-16,
  // e.g. gemini/gemini-3.1-flash-live-preview twice), and filtering is what
  // makes it visible — it collapses the catalog until both copies of a pair
  // land in the same viewport.
  it("de-duplicates repeated catalog ids so the list keys stay unique", () => {
    const models = [
      "gemini/gemini-3.1-flash-live-preview",
      "gemini/gemini-3.1-flash-live-preview",
      "gemini/gemini-2.5-flash-native-audio-latest",
      "gemini/gemini-2.5-flash-native-audio-latest",
    ];
    const { others } = filterAndSplitModels(models, "flash", RECOMMENDED);
    expect(others).toEqual([
      "gemini/gemini-3.1-flash-live-preview",
      "gemini/gemini-2.5-flash-native-audio-latest",
    ]);
    expect(new Set(others).size).toBe(others.length);
  });

  it("de-duplicates a recommended model repeated in the catalog", () => {
    const models = [
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-flash",
      "openai/gpt-4o-mini",
    ];
    const { recommended, others } = filterAndSplitModels(models, "", RECOMMENDED);
    expect(recommended.filter((m) => m === "gemini/gemini-2.5-flash")).toHaveLength(1);
    expect(new Set(others).size).toBe(others.length);
  });

  it("returns an empty match set when nothing matches the filter", () => {
    const models = ["openai/gpt-4o-mini"];
    expect(filterAndSplitModels(models, "zzz", RECOMMENDED)).toEqual({
      recommended: [],
      others: [],
    });
  });
});

describe("resolveBrowseApiKey", () => {
  it("prefers the freshly-typed pending key over the stored one", () => {
    expect(resolveBrowseApiKey("sk-typed", "sk-stored")).toBe("sk-typed");
  });

  it("falls back to the stored key when nothing is pending", () => {
    expect(resolveBrowseApiKey("", "sk-stored")).toBe("sk-stored");
  });
});
