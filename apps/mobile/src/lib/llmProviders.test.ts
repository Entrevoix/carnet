import { describe, expect, it, vi } from "vitest";

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

  it("falls back to omniroute (with a warning) on a totally unknown id — never throws", () => {
    // A dangling activeProviderId (e.g. pointing at a since-deleted custom
    // entry) must NOT throw a generic Error: that wouldn't be an
    // isNotConfiguredError, so the capture-error path would show an opaque
    // failure instead of the familiar not-configured banner. Falling back
    // to omniroute keeps that path sane (omniroute itself raises
    // not-configured when unconfigured, which IS the right banner).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const found = resolveActiveProvider(buildDefaultProviders(), "not-a-real-id");
    expect(found.id).toBe("omniroute");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider id "not-a-real-id"'),
    );
    warnSpy.mockRestore();
  });

  it("falls back to the list's own omniroute entry (not the preset default) when both exist", () => {
    const providers = buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, baseUrl: "https://edited.example.com" } : p,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const found = resolveActiveProvider(providers, "not-a-real-id");
    expect(found.baseUrl).toBe("https://edited.example.com");
    warnSpy.mockRestore();
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
  it("appends a new entry with id custom-<nextCustomSeq> and returns the incremented counter", () => {
    const providers = buildDefaultProviders();
    const { providers: next, nextCustomSeq } = addCustomProvider(providers, 1, {
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
    expect(nextCustomSeq).toBe(2);
  });

  it("uses the caller-supplied counter verbatim, NOT anything derived from the surviving list", () => {
    // The list here has no custom-* entries at all, but the counter says 7
    // (as it would after 6 adds and some deletes) — the id must be
    // custom-7, not custom-1. This is the fix for the id-reuse bug: the
    // seq is a persisted, monotonic counter, never a scan of what's left.
    const providers = buildDefaultProviders();
    const { providers: next, nextCustomSeq } = addCustomProvider(providers, 7, {
      label: "C",
      baseUrl: "c",
      model: "",
      visionModel: "",
    });
    expect(next.at(-1)?.id).toBe("custom-7");
    expect(nextCustomSeq).toBe(8);
  });

  it("never reissues a deleted custom entry's id — simulated add/remove/add sequence", () => {
    // add custom-1 (seq 1 -> 2), remove it, add again: with a persisted
    // counter the second add must be custom-2, never custom-1 again (which
    // would let a stale SecureStore key under "custom-1" silently apply to
    // the new entry — see providerKeys.test.ts's key-reuse guard for the
    // credential half of this regression).
    const base = buildDefaultProviders();
    const first = addCustomProvider(base, 1, {
      label: "A",
      baseUrl: "https://a.example",
      model: "",
      visionModel: "",
    });
    expect(first.providers.at(-1)?.id).toBe("custom-1");

    const afterRemove = removeProvider(first.providers, "custom-1");
    expect(afterRemove.find((p) => p.id === "custom-1")).toBeUndefined();

    const second = addCustomProvider(afterRemove, first.nextCustomSeq, {
      label: "B",
      baseUrl: "https://b.example",
      model: "",
      visionModel: "",
    });
    expect(second.providers.at(-1)?.id).toBe("custom-2");
  });

  it("does not mutate the input array", () => {
    const providers = buildDefaultProviders();
    const snapshot = providers.map((p) => ({ ...p }));
    addCustomProvider(providers, 1, { label: "X", baseUrl: "x", model: "", visionModel: "" });
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
