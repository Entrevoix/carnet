/** Field-level encryption for offline-queue payloads at rest.
 *
 * The capture queue lives in AsyncStorage (see queue.ts), which on Android is
 * an unencrypted SQLite file inside the app sandbox. Its payloads hold raw idea
 * text, voice transcripts, and OCR'd business-card PII (names, emails, phone
 * numbers) — readable via `adb pull` on a rooted or debug device, or by a
 * privileged malicious app. This module seals those payloads so a raw storage
 * dump yields ciphertext.
 *
 * Deliberately NOT applied to the written vault files: those are the user's
 * plaintext Obsidian vault by design (issue #86 scope).
 *
 * ## Construction
 *
 * AES-256-CBC with a per-record random IV, then HMAC-SHA256 over `iv || ct`
 * (encrypt-then-MAC, the composition order that is generically secure). The
 * master key is 256 random bits held in expo-secure-store — Android Keystore
 * backed — and never touches AsyncStorage. Separate encryption and MAC keys are
 * derived from it so the same key material is never used for two purposes.
 *
 * AES-GCM would be the more usual choice and is what issue #86 proposed via
 * expo-crypto, but expo-crypto provides no cipher at all — only digests and
 * random bytes. crypto-js is the available pure-JS cipher and has no
 * authenticated mode, so encrypt-then-MAC is assembled explicitly here rather
 * than relying on a library primitive.
 *
 * ## Why crypto-js for the cipher but expo-crypto for the randomness
 *
 * React Native/Hermes exposes no `globalThis.crypto`, so crypto-js's own
 * `WordArray.random` throws on-device (it refuses to fall back to Math.random).
 * Every random value here therefore comes from expo-crypto's
 * `getRandomBytesAsync`, which reads the platform CSPRNG. */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import AES from "crypto-js/aes";
import HmacSHA256 from "crypto-js/hmac-sha256";
import Base64 from "crypto-js/enc-base64";
import Utf8 from "crypto-js/enc-utf8";
import Hex from "crypto-js/enc-hex";

/** crypto-js's byte-buffer type. CBC mode and PKCS#7 padding are its defaults,
 * so they are left unset below rather than imported — the `mode-cbc` /
 * `pad-pkcs7` entry points ship no typings. */
type WordArray = CryptoJS.lib.WordArray;

/** SecureStore entry holding the base64 master key. Versioned: a future
 * construction change ships a new alias rather than reinterpreting these bytes. */
const KEY_ALIAS = "carnet.queue.key.v1";

/** Envelope discriminator. Also the version marker — `decryptPayload` refuses
 * anything it does not recognize rather than guessing at the layout. */
const ENVELOPE_TAG = "carnet-q1";

/** Master key length in bytes (256-bit). */
const KEY_BYTES = 32;

/** AES block size in bytes — the IV is exactly one block. */
const IV_BYTES = 16;

/** Domain-separation labels, so the encryption key and the MAC key derived from
 * one master are independent. */
const ENC_LABEL = "carnet-queue-enc-v1";
const MAC_LABEL = "carnet-queue-mac-v1";

/** In-memory cache of the derived subkeys. SecureStore reads hit the Android
 * Keystore and the queue decrypts every row on every load, so re-reading per
 * row would be needlessly slow. */
let cachedKeys: { enc: WordArray; mac: WordArray } | null = null;

/** Drop the cached key material. Exported for tests, which simulate reinstall
 * and key-rotation by clearing the SecureStore stub between cases. */
export function __resetQueueKeyCache(): void {
  cachedKeys = null;
}

function bytesToWordArray(bytes: Uint8Array): WordArray {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return Hex.parse(hex);
}

/** Read the master key, generating and persisting one on first use. */
async function loadOrCreateMasterKey(): Promise<WordArray> {
  const existing = await SecureStore.getItemAsync(KEY_ALIAS);
  if (existing) {
    const parsed = Base64.parse(existing);
    // sigBytes is crypto-js's byte length; a truncated entry means the key was
    // corrupted or partially written and must not be used to decrypt.
    if (parsed.sigBytes === KEY_BYTES) return parsed;
  }
  const fresh = bytesToWordArray(await Crypto.getRandomBytesAsync(KEY_BYTES));
  await SecureStore.setItemAsync(KEY_ALIAS, Base64.stringify(fresh));
  return fresh;
}

async function getKeys(): Promise<{ enc: WordArray; mac: WordArray }> {
  if (cachedKeys) return cachedKeys;
  const master = await loadOrCreateMasterKey();
  cachedKeys = {
    enc: HmacSHA256(ENC_LABEL, master),
    mac: HmacSHA256(MAC_LABEL, master),
  };
  return cachedKeys;
}

/** True when `value` looks like an envelope this module produced.
 *
 * Used by the queue's migration path to tell a sealed payload from a legacy
 * plaintext one. Shape-only — it does not verify the MAC, so a `true` result
 * means "attempt decryption", not "authentic". */
export function isEncryptedEnvelope(value: string): boolean {
  if (!value.startsWith(`${ENVELOPE_TAG}:`)) return false;
  return value.split(":").length === 4;
}

/** Seal a payload string into `carnet-q1:<iv>:<ciphertext>:<mac>` (base64 parts). */
export async function encryptPayload(plaintext: string): Promise<string> {
  const { enc, mac } = await getKeys();
  const iv = bytesToWordArray(await Crypto.getRandomBytesAsync(IV_BYTES));
  const encrypted = AES.encrypt(Utf8.parse(plaintext), enc, { iv });
  const ivB64 = Base64.stringify(iv);
  const ctB64 = Base64.stringify(encrypted.ciphertext);
  // MAC covers the IV as well as the ciphertext: authenticating the ciphertext
  // alone would leave the IV malleable, letting an attacker flip bits in the
  // first plaintext block undetected.
  const macB64 = Base64.stringify(HmacSHA256(ivB64 + ctB64, mac));
  return [ENVELOPE_TAG, ivB64, ctB64, macB64].join(":");
}

/** Constant-time string comparison, so MAC verification does not leak how much
 * of a forged tag was correct through its timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Open an envelope produced by {@link encryptPayload}.
 *
 * Throws on a malformed envelope, a failed MAC, or undecodable plaintext —
 * never returns a partially-trusted value. Callers decide whether a bad row is
 * dropped or surfaced; silently returning "" would make a tampered payload look
 * like an empty capture. */
export async function decryptPayload(sealed: string): Promise<string> {
  if (!isEncryptedEnvelope(sealed)) {
    throw new Error("queueCrypto: not an encrypted payload envelope");
  }
  const [, ivB64, ctB64, macB64] = sealed.split(":");
  if (!ivB64 || !ctB64 || !macB64) {
    throw new Error("queueCrypto: malformed envelope");
  }
  const { enc, mac } = await getKeys();

  // Verify BEFORE decrypting — the whole point of encrypt-then-MAC is that
  // attacker-controlled bytes never reach the cipher or the padding check.
  const expected = Base64.stringify(HmacSHA256(ivB64 + ctB64, mac));
  if (!timingSafeEqual(expected, macB64)) {
    throw new Error("queueCrypto: payload failed authentication");
  }

  const iv = Base64.parse(ivB64);
  if (iv.sigBytes !== IV_BYTES) {
    throw new Error("queueCrypto: bad IV length");
  }
  const decrypted = AES.decrypt(
    // crypto-js's decrypt wants a CipherParams-shaped object.
    { ciphertext: Base64.parse(ctB64) } as never,
    enc,
    { iv },
  );
  try {
    return Utf8.stringify(decrypted);
  } catch {
    // Malformed UTF-8 after a valid MAC means the stored bytes were corrupted
    // in place rather than forged; still not safe to hand back.
    throw new Error("queueCrypto: payload did not decode as UTF-8");
  }
}
