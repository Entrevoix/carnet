import { describe, expect, it } from "vitest";

import { filterAndSplitModels } from "./modelBrowser";

const RECOMMENDED = [
  "gemini/gemini-2.5-flash-lite",
  "gemini/gemini-2.5-flash",
  "claude/claude-haiku-4-5-20251001",
  "claude/claude-sonnet-4-6",
] as const;

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

  it("returns an empty match set when nothing matches the filter", () => {
    const models = ["openai/gpt-4o-mini"];
    expect(filterAndSplitModels(models, "zzz", RECOMMENDED)).toEqual({
      recommended: [],
      others: [],
    });
  });
});
