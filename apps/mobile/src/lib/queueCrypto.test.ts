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

// ── Regressions from the adversarial review of #86 ───────────────────────────
describe("queueCrypto hardening", () => {
  it("mints exactly one master key under concurrent first use", async () => {
    // saveRows encrypts every row via Promise.all, so on first run all of those
    // callbacks reach the key check before any await resolves. A cache that
    // stores the resolved value (rather than the in-flight promise) lets each
    // one generate and persist its OWN key — the rows are then sealed under
    // different keys and all but the last are unrecoverable.
    const sealed = await Promise.all([
      encryptPayload("capture ONE"),
      encryptPayload("capture TWO"),
      encryptPayload("capture THREE"),
    ]);

    expect(secureStore.size).toBe(1);
    // Every row must still open under the single surviving key.
    expect(await Promise.all(sealed.map(decryptPayload))).toEqual([
      "capture ONE",
      "capture TWO",
      "capture THREE",
    ]);
  });

  it("authenticates the iv/ciphertext boundary, not just their concatenation", async () => {
    const sealed = await encryptPayload("a real queued capture");
    const [tag, iv, ct, mac] = sealed.split(":");

    // Move characters from the ciphertext field into the IV field. The MAC is
    // unchanged, so a MAC computed over the bare `iv + ct` concatenation still
    // verifies — the split point must be authenticated too.
    for (const shift of [1, 2, 4, 8]) {
      const forged = [tag, iv + ct.slice(0, shift), ct.slice(shift), mac].join(
        ":",
      );
      await expect(
        decryptPayload(forged),
        `re-split by ${shift} must be rejected`,
      ).rejects.toThrow();
    }
  });

  // Two independent defenses cover this: the delimited MAC input makes the
  // encoding canonical, and the encoded-IV length check pins the boundary.
  // Mutation-tested — removing EITHER alone keeps these tests green; removing
  // BOTH turns them red. That is the intended belt-and-braces, not redundancy
  // left in by accident.
  it("rejects every possible re-split of a genuine envelope", async () => {
    const sealed = await encryptPayload("sensitive capture body");
    const [tag, iv, ct, mac] = sealed.split(":");
    const joined = iv + ct;
    let accepted = 0;
    for (let cut = 1; cut < joined.length; cut++) {
      if (cut === iv.length) continue; // the genuine split
      const forged = [tag, joined.slice(0, cut), joined.slice(cut), mac].join(
        ":",
      );
      try {
        await decryptPayload(forged);
        accepted++;
      } catch {
        // expected
      }
    }
    expect(accepted).toBe(0);
  });

  it("refuses to re-mint over a corrupt key entry rather than destroying rows", async () => {
    const sealed = await encryptPayload("queued capture");
    // Simulate a truncated / partially-written SecureStore entry.
    const alias = [...secureStore.keys()][0];
    secureStore.set(alias, Buffer.alloc(8).toString("base64"));
    __resetQueueKeyCache();

    // Silently generating a fresh key here would overwrite the real one and
    // make `sealed` permanently unreadable. Failing loudly keeps it recoverable.
    await expect(encryptPayload("new capture")).rejects.toThrow(/corrupt/i);
    expect(secureStore.get(alias)).toBe(Buffer.alloc(8).toString("base64"));
    void sealed;
  });

  it("does not cache a rejection — a transient keystore error stays retryable", async () => {
    const alias = "carnet.queue.key.v1";
    secureStore.set(alias, Buffer.alloc(8).toString("base64"));
    __resetQueueKeyCache();
    await expect(encryptPayload("x")).rejects.toThrow();

    // Keystore recovers. The next call must succeed WITHOUT an explicit cache
    // reset — deliberately not calling __resetQueueKeyCache here, since doing
    // so would clear the cached rejection and make this test vacuous.
    secureStore.delete(alias);
    const sealed = await encryptPayload("x");
    expect(await decryptPayload(sealed)).toBe("x");
  });
});
