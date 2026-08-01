import { describe, expect, it } from "vitest";

import {
  PROVIDER_PRESETS,
  addCustomProvider,
  buildDefaultProviders,
  removeProvider,
  resolveActiveProvider,
  resolveVisionProvider,
  validateProvider,
  type LlmProvider,
} from "./llmProviders";

describe("PROVIDER_PRESETS", () => {
  it("has exactly the five shipped ids, each with preset === id", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      "relais",
      "omniroute",
      "openai",
      "groq",
      "openrouter",
    ]);
    PROVIDER_PRESETS.forEach((p) => expect(p.preset).toBe(p.id));
  });

  it("relais defaults to the loopback URL; omniroute defaults to a blank URL", () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === "relais")?.baseUrl).toBe(
      "http://127.0.0.1:8080",
    );
    expect(PROVIDER_PRESETS.find((p) => p.id === "omniroute")?.baseUrl).toBe(
      "",
    );
  });
});

describe("buildDefaultProviders", () => {
  it("returns a value-equal copy of PROVIDER_PRESETS", () => {
    expect(buildDefaultProviders()).toEqual(PROVIDER_PRESETS);
  });

  it("returns a fresh array and fresh entry objects each call (no shared mutation)", () => {
    const a = buildDefaultProviders();
    const b = buildDefaultProviders();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0].baseUrl = "mutated";
    expect(b[0].baseUrl).not.toBe("mutated");
    // The shared preset table itself must be untouched too.
    expect(PROVIDER_PRESETS[0].baseUrl).not.toBe("mutated");
  });
});

describe("resolveActiveProvider", () => {
  it("returns the matching entry from the list", () => {
    const providers = buildDefaultProviders();
    const found = resolveActiveProvider(providers, "openai");
    expect(found.id).toBe("openai");
  });

  it("falls back to the matching preset when the list is missing the entry", () => {
    const providers = buildDefaultProviders().filter((p) => p.id !== "groq");
    const found = resolveActiveProvider(providers, "groq");
    expect(found.id).toBe("groq");
    expect(found.preset).toBe("groq");
  });

  it("throws on a totally unknown id (neither in the list nor a preset)", () => {
    expect(() =>
      resolveActiveProvider(buildDefaultProviders(), "not-a-real-id"),
    ).toThrow(/Unknown LLM provider id/);
  });

  it("prefers the list's own entry over the preset default when both exist (edited preset)", () => {
    const providers = buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, baseUrl: "https://edited.example.com" } : p,
    );
    const found = resolveActiveProvider(providers, "omniroute");
    expect(found.baseUrl).toBe("https://edited.example.com");
  });
});

describe("resolveVisionProvider", () => {
  it("returns the active provider when it has a vision model", () => {
    const providers = buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, visionModel: "gpt-4o-mini" } : p,
    );
    const vision = resolveVisionProvider(providers, "omniroute");
    expect(vision?.id).toBe("omniroute");
  });

  it("returns null when the active provider has no vision model (no Phase 3 fallback yet)", () => {
    const providers = buildDefaultProviders();
    expect(resolveVisionProvider(providers, "omniroute")).toBeNull();
  });

  it("treats a whitespace-only visionModel as absent", () => {
    const providers = buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, visionModel: "   " } : p,
    );
    expect(resolveVisionProvider(providers, "omniroute")).toBeNull();
  });
});

describe("validateProvider", () => {
  it("returns no errors for a valid provider", () => {
    const provider: LlmProvider = {
      id: "custom-1",
      label: "My Server",
      baseUrl: "https://my.server",
      model: "some-model",
      visionModel: "",
      preset: null,
    };
    expect(validateProvider(provider)).toEqual([]);
  });

  it("flags a blank label", () => {
    const provider: LlmProvider = {
      id: "custom-1",
      label: "  ",
      baseUrl: "https://my.server",
      model: "",
      visionModel: "",
      preset: null,
    };
    expect(validateProvider(provider)).toContain("Label is required");
  });

  it("flags a blank base URL", () => {
    const provider: LlmProvider = {
      id: "custom-1",
      label: "My Server",
      baseUrl: "",
      model: "",
      visionModel: "",
      preset: null,
    };
    expect(validateProvider(provider)).toContain("Base URL is required");
  });

  it("reports both errors when both fields are blank", () => {
    const provider: LlmProvider = {
      id: "custom-1",
      label: "",
      baseUrl: "",
      model: "",
      visionModel: "",
      preset: null,
    };
    expect(validateProvider(provider)).toHaveLength(2);
  });
});

describe("addCustomProvider", () => {
  it("appends a new entry with id custom-1 to a list with no existing custom entries", () => {
    const providers = buildDefaultProviders();
    const next = addCustomProvider(providers, {
      label: "My Server",
      baseUrl: "https://my.server",
      model: "m",
      visionModel: "",
    });
    expect(next).toHaveLength(providers.length + 1);
    const added = next.at(-1);
    expect(added?.id).toBe("custom-1");
    expect(added?.preset).toBeNull();
    expect(added?.label).toBe("My Server");
  });

  it("numbers the next custom id one past the highest existing custom suffix", () => {
    const providers = [
      ...buildDefaultProviders(),
      { id: "custom-1", label: "A", baseUrl: "a", model: "", visionModel: "", preset: null },
      { id: "custom-3", label: "B", baseUrl: "b", model: "", visionModel: "", preset: null },
    ];
    const next = addCustomProvider(providers, {
      label: "C",
      baseUrl: "c",
      model: "",
      visionModel: "",
    });
    expect(next.at(-1)?.id).toBe("custom-4");
  });

  it("does not mutate the input array", () => {
    const providers = buildDefaultProviders();
    const snapshot = providers.map((p) => ({ ...p }));
    addCustomProvider(providers, { label: "X", baseUrl: "x", model: "", visionModel: "" });
    expect(providers).toEqual(snapshot);
  });
});

describe("removeProvider", () => {
  it("removes a custom entry by id", () => {
    const providers = [
      ...buildDefaultProviders(),
      { id: "custom-1", label: "A", baseUrl: "a", model: "", visionModel: "", preset: null },
    ];
    const next = removeProvider(providers, "custom-1");
    expect(next.find((p) => p.id === "custom-1")).toBeUndefined();
    expect(next).toHaveLength(providers.length - 1);
  });

  it("throws when asked to remove a preset entry", () => {
    const providers = buildDefaultProviders();
    expect(() => removeProvider(providers, "openai")).toThrow(
      /Cannot remove preset provider/,
    );
  });

  it("is a no-op (returns an equivalent array) when the id isn't present", () => {
    const providers = buildDefaultProviders();
    const next = removeProvider(providers, "does-not-exist");
    expect(next).toEqual(providers);
  });

  it("does not mutate the input array", () => {
    const providers = [
      ...buildDefaultProviders(),
      { id: "custom-1", label: "A", baseUrl: "a", model: "", visionModel: "", preset: null },
    ];
    const snapshot = providers.map((p) => ({ ...p }));
    removeProvider(providers, "custom-1");
    expect(providers).toEqual(snapshot);
  });
});
