import { describe, expect, it } from "vitest";

import { buildDefaultProviders, type LlmProvider } from "./llmProviders";
import {
  applyEditBuffer,
  applyPickedModelToBuffer,
  editBufferFromProvider,
  reassignIdentityAfterDelete,
  shouldShowInsecureTransportToggle,
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
  it("copies the four text fields plus allowInsecureTransport (defaulted false)", () => {
    expect(editBufferFromProvider(customProvider)).toEqual({
      label: "My Server",
      baseUrl: "https://my.server",
      model: "some-model",
      visionModel: "some-vision-model",
      allowInsecureTransport: false,
    });
  });

  it("carries an explicit allowInsecureTransport: true through unchanged", () => {
    expect(
      editBufferFromProvider({ ...customProvider, allowInsecureTransport: true }),
    ).toMatchObject({ allowInsecureTransport: true });
  });
});

describe("applyEditBuffer", () => {
  const buffer: EditBuffer = {
    label: "Renamed",
    baseUrl: "https://new.server",
    model: "new-model",
    visionModel: "new-vision-model",
    allowInsecureTransport: false,
  };

  it("applies baseUrl/model/visionModel/label/allowInsecureTransport to a custom entry", () => {
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
      allowInsecureTransport: false,
    });
  });

  it("applies allowInsecureTransport: true to a preset entry too, when the URL is unchanged", () => {
    // baseUrl deliberately matches the stored omniroute preset's (blank) so
    // this exercises consent APPLICATION, not the #176 reset-on-URL-change
    // behavior covered separately below.
    const providers = buildDefaultProviders();
    const stored = providers.find((p) => p.id === "omniroute");
    const next = applyEditBuffer(providers, "omniroute", {
      ...buffer,
      baseUrl: stored?.baseUrl ?? "",
      allowInsecureTransport: true,
    });
    const updated = next.find((p) => p.id === "omniroute");
    expect(updated?.allowInsecureTransport).toBe(true);
  });

  // #176 MEDIUM fix: consent is granted to a specific host — editing the URL
  // must force re-consent for the new one, not silently carry the old
  // host's "yes" over.
  describe("allowInsecureTransport reset-on-URL-change (#176)", () => {
    it("resets allowInsecureTransport to false when baseUrl changed from the stored value", () => {
      const consented: LlmProvider = { ...customProvider, allowInsecureTransport: true };
      const providers = [...buildDefaultProviders(), consented];
      const next = applyEditBuffer(providers, "custom-1", {
        ...buffer,
        baseUrl: "http://different.example.com",
        allowInsecureTransport: true,
      });
      const updated = next.find((p) => p.id === "custom-1");
      expect(updated?.allowInsecureTransport).toBe(false);
    });

    it("preserves allowInsecureTransport when baseUrl is unchanged (save without editing the URL)", () => {
      const consented: LlmProvider = { ...customProvider, allowInsecureTransport: true };
      const providers = [...buildDefaultProviders(), consented];
      const next = applyEditBuffer(providers, "custom-1", {
        ...buffer,
        baseUrl: consented.baseUrl,
        allowInsecureTransport: true,
      });
      const updated = next.find((p) => p.id === "custom-1");
      expect(updated?.allowInsecureTransport).toBe(true);
    });

    it("treats whitespace-only differences as unchanged (trimmed comparison)", () => {
      const consented: LlmProvider = {
        ...customProvider,
        baseUrl: "http://tailnet.example.com",
        allowInsecureTransport: true,
      };
      const providers = [...buildDefaultProviders(), consented];
      const next = applyEditBuffer(providers, "custom-1", {
        ...buffer,
        baseUrl: "  http://tailnet.example.com  ",
        allowInsecureTransport: true,
      });
      const updated = next.find((p) => p.id === "custom-1");
      expect(updated?.allowInsecureTransport).toBe(true);
    });

    it("does not resurrect consent on a URL change even if the buffer's toggle is false", () => {
      const consented: LlmProvider = { ...customProvider, allowInsecureTransport: true };
      const providers = [...buildDefaultProviders(), consented];
      const next = applyEditBuffer(providers, "custom-1", {
        ...buffer,
        baseUrl: "http://different.example.com",
        allowInsecureTransport: false,
      });
      const updated = next.find((p) => p.id === "custom-1");
      expect(updated?.allowInsecureTransport).toBe(false);
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
    allowInsecureTransport: false,
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
      { activeProviderId: "omniroute", fallbackProviderId: "custom-1", visionProviderId: null, enhanceProviderId: null },
      "custom-1",
    );
    expect(result.fallbackProviderId).toBeNull();
    expect(result.activeProviderId).toBe("omniroute");
  });

  it("clears visionProviderId to null when it pointed at the deleted entry", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "omniroute", fallbackProviderId: null, visionProviderId: "custom-1", enhanceProviderId: null },
      "custom-1",
    );
    expect(result.visionProviderId).toBeNull();
  });

  it("leaves fallback/vision untouched when the deleted entry is neither active nor fallback nor vision", () => {
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "omniroute", fallbackProviderId: "relais", visionProviderId: "openai", enhanceProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("omniroute");
    expect(result.fallbackProviderId).toBe("relais");
    expect(result.visionProviderId).toBe("openai");
  });

  it("clears enhanceProviderId to null when it pointed at the deleted entry", () => {
    // resolveEnhanceProvider already degrades a stale id to the active entry,
    // so this is consistency rather than a crash guard — but Settings showing
    // a deleted entry as the Enhance model is the "recoverable but wrong to
    // ship" case the identity group exists to prevent.
    const result = reassignIdentityAfterDelete(
      {
        activeProviderId: "omniroute",
        fallbackProviderId: null,
        visionProviderId: null,
        enhanceProviderId: "custom-1",
      },
      "custom-1",
    );
    expect(result.enhanceProviderId).toBeNull();
  });

  it("leaves an unrelated enhanceProviderId untouched", () => {
    const result = reassignIdentityAfterDelete(
      {
        activeProviderId: "omniroute",
        fallbackProviderId: null,
        visionProviderId: null,
        enhanceProviderId: "openai",
      },
      "custom-1",
    );
    expect(result.enhanceProviderId).toBe("openai");
  });

  it("clears a deleted enhance entry even when the ACTIVE entry is deleted in the same call", () => {
    // The active-reassignment branch returns early with its own object literal
    // — a dropped enhanceProviderId there would leave the dangling id behind.
    const result = reassignIdentityAfterDelete(
      {
        activeProviderId: "custom-1",
        fallbackProviderId: "relais",
        visionProviderId: null,
        enhanceProviderId: "custom-1",
      },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("relais");
    expect(result.enhanceProviderId).toBeNull();
  });

  it("reassigns a deleted ACTIVE provider to the fallback when one is configured, AND vacates the fallback slot", () => {
    // Mutation-catch: if fallbackProviderId were threaded straight through
    // unchanged (instead of forced to null) after being promoted, the
    // fallback chain would retry the exact same endpoint it just failed
    // over from — a "configured" fallback that can never fire.
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: "relais", visionProviderId: null, enhanceProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("relais");
    expect(result.fallbackProviderId).toBeNull();
  });

  it("reassigns a deleted ACTIVE provider to omniroute when no fallback is configured", () => {
    // Mutation-catch: if `?? "omniroute"` were dropped (or replaced with the
    // deleted id itself), the active id would be left dangling — this is
    // the non-negotiable the Phase 4 spec calls out explicitly.
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: null, visionProviderId: null, enhanceProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("omniroute");
  });

  it("reassigns to omniroute (not the deleted id) when active AND fallback both point at the deleted entry", () => {
    // Edge case: fallbackProviderId === deletedId too. The fallback clears
    // to null FIRST, so the active reassignment must not pick up the
    // stale (deleted) fallback value.
    const result = reassignIdentityAfterDelete(
      { activeProviderId: "custom-1", fallbackProviderId: "custom-1", visionProviderId: null, enhanceProviderId: null },
      "custom-1",
    );
    expect(result.activeProviderId).toBe("omniroute");
    expect(result.fallbackProviderId).toBeNull();
  });
});

// #176 — the cleartext-consent toggle must appear ONLY where consent is
// meaningful: plain http:// AND not already covered by the credential gate.
describe("shouldShowInsecureTransportToggle", () => {
  it("shows for a plaintext public/tailnet-shaped host", () => {
    expect(shouldShowInsecureTransportToggle("http://100.100.50.1:8080")).toBe(true);
    expect(shouldShowInsecureTransportToggle("http://my-box.tailnet.ts.net")).toBe(true);
  });

  it("hides for https:// (nothing to consent to)", () => {
    expect(shouldShowInsecureTransportToggle("https://my-box.tailnet.ts.net")).toBe(false);
  });

  it("hides for a loopback/RFC1918 host already covered by the gate", () => {
    expect(shouldShowInsecureTransportToggle("http://127.0.0.1:8080")).toBe(false);
    expect(shouldShowInsecureTransportToggle("http://192.168.1.20")).toBe(false);
  });

  it("hides for a blank base URL", () => {
    expect(shouldShowInsecureTransportToggle("")).toBe(false);
    expect(shouldShowInsecureTransportToggle("   ")).toBe(false);
  });
});
