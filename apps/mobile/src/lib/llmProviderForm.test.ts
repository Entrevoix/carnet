import { describe, expect, it } from "vitest";

import { buildDefaultProviders, type LlmProvider } from "./llmProviders";
import {
  applyEditBuffer,
  applyPickedModelToBuffer,
  editBufferFromProvider,
  reassignIdentityAfterDelete,
  type EditBuffer,
} from "./llmProviderForm";

const customProvider: LlmProvider = {
  id: "custom-1",
  label: "My Server",
  baseUrl: "https://my.server",
  model: "some-model",
  visionModel: "some-vision-model",
  preset: null,
};

describe("editBufferFromProvider", () => {
  it("copies the four editable fields", () => {
    expect(editBufferFromProvider(customProvider)).toEqual({
      label: "My Server",
      baseUrl: "https://my.server",
      model: "some-model",
      visionModel: "some-vision-model",
    });
  });
});

describe("applyEditBuffer", () => {
  const buffer: EditBuffer = {
    label: "Renamed",
    baseUrl: "https://new.server",
    model: "new-model",
    visionModel: "new-vision-model",
  };

  it("applies baseUrl/model/visionModel/label to a custom entry", () => {
    const providers = [...buildDefaultProviders(), customProvider];
    const next = applyEditBuffer(providers, "custom-1", buffer);
    const updated = next.find((p) => p.id === "custom-1");
    expect(updated).toEqual({
      id: "custom-1",
      label: "Renamed",
      baseUrl: "https://new.server",
      model: "new-model",
      visionModel: "new-vision-model",
      preset: null,
    });
  });

  it("does NOT overwrite a preset's label even if the buffer carries an edited one", () => {
    // Mutation-catch: if the `p.preset === null ? buffer.label : p.label`
    // ternary were replaced with `buffer.label` unconditionally, this would
    // assert "Renamed" against the real "OmniRoute" and fail.
    const providers = buildDefaultProviders();
    const next = applyEditBuffer(providers, "omniroute", buffer);
    const updated = next.find((p) => p.id === "omniroute");
    expect(updated?.label).toBe("OmniRoute");
    expect(updated?.baseUrl).toBe("https://new.server");
  });

  it("never touches id or preset", () => {
    const providers = [...buildDefaultProviders(), customProvider];
    const next = applyEditBuffer(providers, "custom-1", buffer);
    const updated = next.find((p) => p.id === "custom-1");
    expect(updated?.id).toBe("custom-1");
    expect(updated?.preset).toBeNull();
  });

  it("leaves every other entry untouched", () => {
    const providers = buildDefaultProviders();
    const next = applyEditBuffer(providers, "omniroute", buffer);
    const relais = next.find((p) => p.id === "relais");
    expect(relais).toEqual(providers.find((p) => p.id === "relais"));
  });

  it("does not mutate the input array", () => {
    const providers = buildDefaultProviders();
    const snapshot = providers.map((p) => ({ ...p }));
    applyEditBuffer(providers, "omniroute", buffer);
    expect(providers).toEqual(snapshot);
  });

  it("returns the list unchanged (new array) when the id is not found", () => {
    const providers = buildDefaultProviders();
    const next = applyEditBuffer(providers, "does-not-exist", buffer);
    expect(next).toEqual(providers);
    expect(next).not.toBe(providers);
  });
});

describe("applyPickedModelToBuffer", () => {
  const buffer: EditBuffer = {
    label: "L",
    baseUrl: "https://x",
    model: "old-chat",
    visionModel: "old-vision",
  };

  it("updates model for the chat target and leaves visionModel untouched", () => {
    const next = applyPickedModelToBuffer(buffer, "chat", "new-chat");
    expect(next.model).toBe("new-chat");
    expect(next.visionModel).toBe("old-vision");
  });

  it("updates visionModel for the vision target and leaves model untouched", () => {
    // Mutation-catch: if the branch condition were flipped, a vision pick
    // would land on `model` instead — this asserts BOTH fields.
    const next = applyPickedModelToBuffer(buffer, "vision", "new-vision");
    expect(next.visionModel).toBe("new-vision");
    expect(next.model).toBe("old-chat");
  });

  it("does not mutate the input buffer", () => {
    applyPickedModelToBuffer(buffer, "chat", "new-chat");
    expect(buffer.model).toBe("old-chat");
  });
});

describe("reassignIdentityAfterDelete", () => {
  it("clears fallbackProviderId to null when it pointed at the deleted entry", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "omniroute", fallbackProviderId: "custom-1", visionProviderId: null },
      "custom-1",
    );
    expect(result.fallbackProviderId).toBeNull();
    expect(result.activeProviderId).toBe("omniroute");
  });

  it("clears visionProviderId to null when it pointed at the deleted entry", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "omniroute", fallbackProviderId: null, visionProviderId: "custom-1" },
      "custom-1",
    );
    expect(result.visionProviderId).toBeNull();
  });

  it("leaves fallback/vision untouched when they point elsewhere", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: "relais", visionProviderId: "openai" },
      "custom-1",
    );
    expect(result.fallbackProviderId).toBe("relais");
    expect(result.visionProviderId).toBe("openai");
  });

  it("reassigns a deleted ACTIVE provider to the fallback when one is configured", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: "relais", visionProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("relais");
  });

  it("reassigns a deleted ACTIVE provider to omniroute when no fallback is configured", () => {
    // Mutation-catch: if `?? "omniroute"` were dropped (or replaced with the
    // deleted id itself), the active id would be left dangling — this is
    // the non-negotiable the Phase 4 spec calls out explicitly.
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: null, visionProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("omniroute");
  });

  it("reassigns to omniroute (not the deleted id) when active AND fallback both point at the deleted entry", () => {
    // Edge case: fallbackProviderId === deletedId too. The fallback clears
    // to null FIRST, so the active reassignment must not pick up the
    // stale (deleted) fallback value.
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: "custom-1", visionProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("omniroute");
    expect(result.fallbackProviderId).toBeNull();
  });
});
