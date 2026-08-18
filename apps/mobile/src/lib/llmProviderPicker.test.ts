import { describe, expect, it } from "vitest";

import { buildDefaultProviders, type LlmProvider } from "./llmProviders";
import { resolveBrowseSource, resolvePickerPresentation } from "./llmProviderPicker";

const customProvider: LlmProvider = {
  id: "custom-1",
  label: "My Server",
  baseUrl: "https://my.server",
  model: "some-model",
  visionModel: "some-vision-model",
  preset: null,
};

describe("resolvePickerPresentation", () => {
  const ids = {
    activeProviderId: "omniroute",
    fallbackProviderId: "relais",
    visionProviderId: "openai",
    enhanceProviderId: "custom-1",
  };

  it("resolves the active picker's title and selection", () => {
    expect(resolvePickerPresentation("active", ids)).toEqual({
      title: "Choose LLM provider",
      selectedId: "omniroute",
    });
  });

  it("resolves the fallback picker's title and selection", () => {
    expect(resolvePickerPresentation("fallback", ids)).toEqual({
      title: "Offline fallback provider",
      selectedId: "relais",
    });
  });

  it("resolves the vision picker's title and selection", () => {
    expect(resolvePickerPresentation("vision", ids)).toEqual({
      title: "Vision provider",
      selectedId: "openai",
    });
  });

  it("resolves the enhance picker's title and selection", () => {
    expect(resolvePickerPresentation("enhance", ids)).toEqual({
      title: "Enhance model",
      selectedId: "custom-1",
    });
  });

  it("falls back to the active picker's title and selection when the mode is null", () => {
    // A closed picker (pickerMode === null) still needs a value to render
    // before the modal finishes dismissing off-screen.
    expect(resolvePickerPresentation(null, ids)).toEqual({
      title: "Choose LLM provider",
      selectedId: "omniroute",
    });
  });
});

describe("resolveBrowseSource", () => {
  const active = customProvider;
  const providers = [...buildDefaultProviders(), customProvider];

  it("resolves chat/vision targets to no source provider, keyed on the active entry", () => {
    expect(resolveBrowseSource("chat", providers, null, "custom-1", active)).toEqual({
      src: null,
      keyOwnerId: "custom-1",
    });
    expect(resolveBrowseSource("vision", providers, "openai", "custom-1", active)).toEqual({
      src: null,
      keyOwnerId: "custom-1",
    });
  });

  it("resolves the enhance target to the enhance provider when one is set", () => {
    const result = resolveBrowseSource("enhance", providers, "relais", "custom-1", active);
    expect(result.src?.id).toBe("relais");
    expect(result.keyOwnerId).toBe("relais");
  });

  it("falls back to the active provider id when no enhance provider is set", () => {
    const result = resolveBrowseSource("enhance", providers, null, "omniroute", active);
    expect(result.src?.id).toBe("omniroute");
    expect(result.keyOwnerId).toBe("omniroute");
  });

  it("falls back to the passed-in active entry when the resolved id isn't in the list", () => {
    // Defensive branch: providerList.find(...) misses, so `?? active` wins.
    const result = resolveBrowseSource("enhance", providers, "does-not-exist", "also-missing", active);
    expect(result.src).toBe(active);
    expect(result.keyOwnerId).toBe(active.id);
  });
});
