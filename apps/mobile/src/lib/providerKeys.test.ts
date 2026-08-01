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

import { deleteKey, getKey, setKey } from "./providerKeys";

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
