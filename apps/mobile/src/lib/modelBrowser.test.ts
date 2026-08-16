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
  // llm.grepon.cc really does serve repeated ids (e.g.
  // gemini/gemini-3.1-flash-live-preview twice), and filtering is what makes it
  // visible — it collapses the catalog until both copies of a pair land in the
  // same viewport.
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

  // The query from the original bug report. "mini" is a substring of ge-MINI-ni,
  // so it drags in the whole gemini/* family — which is exactly where every
  // duplicated id lives. Searching "mini" hit all 4 of them at once; searching
  // "gpt" hits none and never flickered. Pinned so a future filter change can't
  // quietly reintroduce the reported symptom.
  it("keeps keys unique for the reported 'mini' query, which matches ge-mini-ni", () => {
    const models = [
      "ddgw/gpt-5.4-mini",
      "gemini/gemini-3.1-flash-live-preview",
      "gemini/gemini-3.1-flash-live-preview",
      "openai/gpt-4o-mini",
    ];
    const { others } = filterAndSplitModels(models, "mini", RECOMMENDED);
    expect(others).toContain("gemini/gemini-3.1-flash-live-preview");
    expect(new Set(others).size).toBe(others.length);
  });

  // Named for what it actually checks: `recommended` is built by filtering the
  // RECOMMENDED constant (which has no repeats), so it cannot duplicate whatever
  // the catalog does — the property worth pinning is that a repeated recommended
  // model neither leaks into `others` nor doubles up.
  it("keeps a repeated recommended model out of others and single in recommended", () => {
    const models = [
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-flash",
      "openai/gpt-4o-mini",
    ];
    const { recommended, others } = filterAndSplitModels(models, "", RECOMMENDED);
    expect(recommended.filter((m) => m === "gemini/gemini-2.5-flash")).toHaveLength(1);
    expect(others).not.toContain("gemini/gemini-2.5-flash");
    expect(new Set(others).size).toBe(others.length);
  });

  // WHICH copy survives a collapse is load-bearing, and this is its only guard.
  // Verified by mutation: rewriting the dedupe to keep the LAST occurrence
  // instead of the first fails this test and passes all 14 others, because
  // every other catalog fixture here is already duplicate-free. (An
  // order-destroying sort is caught more widely; keep-the-other-copy is not.)
  it("preserves first-occurrence catalog order in others when collapsing repeats", () => {
    const models = ["zeta", "alpha", "zeta", "mid", "alpha"];
    const { others } = filterAndSplitModels(models, "", []);
    expect(others).toEqual(["zeta", "alpha", "mid"]);
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
