import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// expo-crypto is the ONLY source of entropy (RN/Hermes exposes no
// globalThis.crypto). Back it with Node's real CSPRNG so the tests exercise
// genuine randomness rather than a fixed stub — an IV that never varies would
// hide the "same plaintext encrypts differently" property.
vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: async (n: number) => {
    const out = new Uint8Array(n);
    webcrypto.getRandomValues(out);
    return out;
  },
}));

const secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secureStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    secureStore.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    secureStore.delete(k);
  },
}));

import {
  __resetQueueKeyCache,
  decryptPayload,
  encryptPayload,
  isEncryptedEnvelope,
} from "./queueCrypto";

beforeEach(() => {
  secureStore.clear();
  __resetQueueKeyCache();
});

describe("queueCrypto", () => {
  it("round-trips a payload", async () => {
    const plain = JSON.stringify({ text: "a private idea", tags: ["x"] });
    const sealed = await encryptPayload(plain);
    expect(await decryptPayload(sealed)).toBe(plain);
  });

  it("round-trips unicode, emoji and large payloads", async () => {
    const cases = [
      "café — naïve — 日本語 — 🔐🙂",
      "line1\nline2\ttabbed\r\n",
      JSON.stringify({ ocr: "Jane Doe\njane@example.com\n+1 555 0100" }),
      "A".repeat(200_000),
      "",
    ];
    for (const plain of cases) {
      const sealed = await encryptPayload(plain);
      expect(await decryptPayload(sealed), `round-trip: ${plain.slice(0, 20)}`).toBe(
        plain,
      );
    }
  });

  it("does not leave the plaintext recoverable in the envelope", async () => {
    const plain = "jane@example.com +1 555 0100 secret business card";
    const sealed = await encryptPayload(plain);
    expect(sealed).not.toContain("jane@example.com");
    expect(sealed).not.toContain("555");
    expect(sealed).not.toContain("secret");
    // Guard against an accidental base64-of-plaintext "encryption".
    const body = sealed.split(":").slice(1).join(":");
    expect(Buffer.from(body, "base64").toString("utf8")).not.toContain("jane");
  });

  it("produces a different ciphertext each time (per-record IV)", async () => {
    const plain = "identical input";
    const a = await encryptPayload(plain);
    const b = await encryptPayload(plain);
    expect(a).not.toBe(b);
    expect(await decryptPayload(a)).toBe(plain);
    expect(await decryptPayload(b)).toBe(plain);
  });

  it("rejects a tampered ciphertext (encrypt-then-MAC)", async () => {
    const sealed = await encryptPayload("original content");
    const [tag, iv, ct, mac] = sealed.split(":");
    // Flip a character in the ciphertext body.
    const flipped = ct[0] === "A" ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    await expect(
      decryptPayload([tag, iv, flipped, mac].join(":")),
    ).rejects.toThrow();
  });

  it("rejects a tampered IV", async () => {
    const sealed = await encryptPayload("original content");
    const [tag, iv, ct, mac] = sealed.split(":");
    const flipped = iv[0] === "A" ? `B${iv.slice(1)}` : `A${iv.slice(1)}`;
    await expect(
      decryptPayload([tag, flipped, ct, mac].join(":")),
    ).rejects.toThrow();
  });

  it("rejects a stripped or forged MAC", async () => {
    const sealed = await encryptPayload("original content");
    const [tag, iv, ct] = sealed.split(":");
    await expect(decryptPayload([tag, iv, ct, ""].join(":"))).rejects.toThrow();
    await expect(
      decryptPayload([tag, iv, ct, Buffer.alloc(32).toString("base64")].join(":")),
    ).rejects.toThrow();
  });

  it("rejects malformed envelopes rather than returning garbage", async () => {
    for (const bad of [
      "",
      "not-an-envelope",
      "carnet-q1:",
      "carnet-q1:a:b",
      "carnet-q1:!!!:!!!:!!!",
      '{"text":"legacy plaintext row"}',
    ]) {
      await expect(decryptPayload(bad), `should reject: ${bad}`).rejects.toThrow();
    }
  });

  it("cannot be decrypted with a different key", async () => {
    const sealed = await encryptPayload("secret");
    // Simulate a reinstall / key rotation: new key material in SecureStore.
    secureStore.clear();
    __resetQueueKeyCache();
    await expect(decryptPayload(sealed)).rejects.toThrow();
  });

  it("generates the key once and reuses it from SecureStore", async () => {
    await encryptPayload("first");
    const keyAfterFirst = [...secureStore.values()];
    expect(keyAfterFirst).toHaveLength(1);

    __resetQueueKeyCache();
    const sealed = await encryptPayload("second");
    expect([...secureStore.values()]).toEqual(keyAfterFirst);
    expect(await decryptPayload(sealed)).toBe("second");
  });

  it("stores a 256-bit key, not something derived from a constant", async () => {
    await encryptPayload("x");
    const stored = [...secureStore.values()][0];
    expect(Buffer.from(stored, "base64")).toHaveLength(32);

    // A second install must not produce the same key.
    secureStore.clear();
    __resetQueueKeyCache();
    await encryptPayload("x");
    expect([...secureStore.values()][0]).not.toBe(stored);
  });

  describe("isEncryptedEnvelope", () => {
    it("recognizes sealed values", async () => {
      expect(isEncryptedEnvelope(await encryptPayload("x"))).toBe(true);
    });

    it("rejects legacy plaintext rows so migration can detect them", () => {
      expect(isEncryptedEnvelope('{"text":"legacy"}')).toBe(false);
      expect(isEncryptedEnvelope("")).toBe(false);
      expect(isEncryptedEnvelope("carnet-q1")).toBe(false);
      expect(isEncryptedEnvelope("carnet-q1:a:b")).toBe(false);
    });
  });
});
