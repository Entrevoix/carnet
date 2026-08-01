import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory SecureStore mock — same pattern as settings.test.ts.
const _secure = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => _secure.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    _secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    _secure.delete(k);
  }),
}));

import { buildDefaultProviders } from "./llmProviders";
import {
  deleteKey,
  getKey,
  removeProviderAndKey,
  setKey,
} from "./providerKeys";

beforeEach(() => {
  _secure.clear();
});

// ── Alias map — the constraint most likely to break silently. `omniroute`
// and `relais` MUST keep reading/writing the exact pre-provider-list
// SecureStore aliases (settings.ts's OMNIROUTE_API_KEY / LOCAL_LLM_API_KEY
// constants) — a key that never moves cannot be lost. Every other id uses
// the generic carnet.llm.key.<id> namespace.

describe("getKey / setKey alias routing", () => {
  it("omniroute reads/writes the legacy carnet_omniroute_api_key alias, not a new one", async () => {
    await setKey("omniroute", "sk-omni");
    expect(_secure.get("carnet_omniroute_api_key")).toBe("sk-omni");
    expect(_secure.has("carnet.llm.key.omniroute")).toBe(false);
    expect(await getKey("omniroute")).toBe("sk-omni");
  });

  it("relais reads/writes the legacy carnet_local_llm_api_key alias, not a new one", async () => {
    await setKey("relais", "local-secret");
    expect(_secure.get("carnet_local_llm_api_key")).toBe("local-secret");
    expect(_secure.has("carnet.llm.key.relais")).toBe(false);
    expect(await getKey("relais")).toBe("local-secret");
  });

  it("a preset with no pre-existing key (openai) uses the generic carnet.llm.key.<id> alias", async () => {
    await setKey("openai", "sk-openai");
    expect(_secure.get("carnet.llm.key.openai")).toBe("sk-openai");
    expect(await getKey("openai")).toBe("sk-openai");
  });

  it("a custom provider id uses the generic carnet.llm.key.<id> alias", async () => {
    await setKey("custom-1", "sk-custom");
    expect(_secure.get("carnet.llm.key.custom-1")).toBe("sk-custom");
    expect(await getKey("custom-1")).toBe("sk-custom");
  });

  it("reading a key that was pre-seeded at the legacy alias (simulating an existing install) works with no migration step", async () => {
    // This is the exact scenario the alias map exists for: an install that
    // already has a key stored under the OLD name, from before the
    // provider list existed.
    _secure.set("carnet_omniroute_api_key", "pre-existing-key");
    expect(await getKey("omniroute")).toBe("pre-existing-key");
  });

  it("getKey returns empty string, not null/undefined, when nothing is stored", async () => {
    expect(await getKey("omniroute")).toBe("");
    expect(await getKey("relais")).toBe("");
    expect(await getKey("openrouter")).toBe("");
    expect(await getKey("custom-9")).toBe("");
  });
});

describe("setKey blank-value semantics", () => {
  it("deletes the stored key when set to an empty string", async () => {
    await setKey("omniroute", "sk-omni");
    await setKey("omniroute", "");
    expect(_secure.has("carnet_omniroute_api_key")).toBe(false);
    expect(await getKey("omniroute")).toBe("");
  });

  it("deletes the stored key when set to a whitespace-only string", async () => {
    await setKey("openai", "sk-openai");
    await setKey("openai", "   ");
    expect(_secure.has("carnet.llm.key.openai")).toBe(false);
  });

  it("trims a value before storing it", async () => {
    await setKey("openai", "  sk-openai  ");
    expect(_secure.get("carnet.llm.key.openai")).toBe("sk-openai");
  });
});

describe("deleteKey", () => {
  it("removes a stored key outright, at the correct alias", async () => {
    await setKey("custom-1", "sk-custom");
    await deleteKey("custom-1");
    expect(_secure.has("carnet.llm.key.custom-1")).toBe(false);
    expect(await getKey("custom-1")).toBe("");
  });

  it("deleting a never-set id is a no-op, not a throw", async () => {
    await expect(deleteKey("never-set")).resolves.toBeUndefined();
  });

  it("deleting omniroute's key only touches the legacy alias, leaving relais's key intact", async () => {
    await setKey("omniroute", "sk-omni");
    await setKey("relais", "local-secret");
    await deleteKey("omniroute");
    expect(await getKey("omniroute")).toBe("");
    expect(await getKey("relais")).toBe("local-secret");
  });
});

// ── aliasFor hardening (finding #4c): a plain object literal inherits
// Object.prototype, so an id like "toString" would resolve to a PROTOTYPE
// FUNCTION via the old `LEGACY_KEY_ALIASES[id]`, and `?? fallback` never
// fires for a truthy function value — silently storing a secret under a
// garbage, non-string "alias". Unreachable while ids are hardcoded, but
// becomes reachable the moment a provider id is user-editable (Phase 4).

describe("aliasFor hardening — prototype-pollution-shaped ids", () => {
  it("a provider id shadowing an Object.prototype member (toString) stores under the generic namespace, not garbage", async () => {
    await setKey("toString", "sk-toString");
    expect(_secure.get("carnet.llm.key.toString")).toBe("sk-toString");
    expect(await getKey("toString")).toBe("sk-toString");
  });

  it("constructor and hasOwnProperty behave the same way", async () => {
    await setKey("constructor", "sk-constructor");
    await setKey("hasOwnProperty", "sk-hasOwnProperty");
    expect(await getKey("constructor")).toBe("sk-constructor");
    expect(await getKey("hasOwnProperty")).toBe("sk-hasOwnProperty");
    // The two ids must not collide with each other or with anything else.
    expect(_secure.get("carnet.llm.key.constructor")).toBe("sk-constructor");
    expect(_secure.get("carnet.llm.key.hasOwnProperty")).toBe(
      "sk-hasOwnProperty",
    );
  });

  it("rejects an id containing characters outside [A-Za-z0-9_-]", async () => {
    await expect(getKey("../escape")).rejects.toThrow(/Invalid LLM provider id/);
    await expect(setKey("has.dots", "x")).rejects.toThrow(
      /Invalid LLM provider id/,
    );
    await expect(deleteKey("has space")).rejects.toThrow(
      /Invalid LLM provider id/,
    );
  });
});

describe("removeProviderAndKey", () => {
  it("deletes the stored key AND removes the list entry", async () => {
    const providers = [
      ...buildDefaultProviders(),
      {
        id: "custom-1",
        label: "My Server",
        baseUrl: "https://my.server",
        model: "m",
        visionModel: "",
        preset: null,
      },
    ];
    await setKey("custom-1", "sk-custom-1");

    const next = await removeProviderAndKey(providers, "custom-1");

    expect(next.find((p) => p.id === "custom-1")).toBeUndefined();
    expect(await getKey("custom-1")).toBe("");
  });

  it("deletes the key even when there is no matching list entry (defensive cleanup)", async () => {
    await setKey("custom-9", "sk-orphaned");
    const providers = buildDefaultProviders();
    const next = await removeProviderAndKey(providers, "custom-9");
    expect(next).toEqual(providers);
    expect(await getKey("custom-9")).toBe("");
  });

  it("throws (and leaves the key intact) when asked to remove a preset — key-delete-first ordering must not destroy a preset's key on a rejected removal", async () => {
    await setKey("openai", "sk-openai");
    await expect(removeProviderAndKey(buildDefaultProviders(), "openai")).rejects.toThrow(
      /Cannot remove preset provider/,
    );
  });

  it("key-delete-first ordering: a rejected SecureStore delete propagates instead of silently returning a list with the entry dropped", async () => {
    // Proves the "key first, then list entry" ordering the docstring
    // promises: if deleteKey() throws, removeProviderAndKey must reject —
    // NOT swallow the failure and return a list that looks successfully
    // pruned while the key is still (or might still be) sitting in
    // SecureStore. A caller that persisted a resolved-but-wrong result here
    // would show the entry as gone while its key silently lingered.
    const secureStore = await import("expo-secure-store");
    const deleteSpy = vi
      .spyOn(secureStore, "deleteItemAsync")
      .mockRejectedValueOnce(new Error("keychain locked"));

    const providers = [
      ...buildDefaultProviders(),
      {
        id: "custom-1",
        label: "A",
        baseUrl: "a",
        model: "",
        visionModel: "",
        preset: null,
      },
    ];

    await expect(removeProviderAndKey(providers, "custom-1")).rejects.toThrow(
      "keychain locked",
    );

    deleteSpy.mockRestore();
  });
});
