/**
 * Config-precondition guards for the merged LLM client (./llmClient). Split
 * out of llmClient.ts as a move-only extraction — see llmClient.ts's module
 * comment for the full decomposition map.
 *
 * `assertVisionReady` takes a `VisionReadyConfig` shape defined HERE rather
 * than importing `ProviderConfig` from ./llmClient: llmClient.ts imports
 * these guards, so importing ProviderConfig back would form a cycle.
 * `ProviderConfig extends VisionReadyConfig` in llmClient.ts, so callers
 * pass it unchanged and get the same type-checking they always did — the
 * dependency points llmClient -> llmGuards, never the reverse.
 */

import { isCredentialSafeUrl } from "./netAllowlist";
import { LlmClientError } from "./llmErrors";

/**
 * The fields `assertVisionReady` needs to check readiness — deliberately
 * NOT the same thing as "this provider has a working credential". Passing
 * this gate means vision model + URL + transport are all present and safe;
 * it says nothing about whether `apiKey` is actually valid, and callers
 * must not treat it as a stand-in for a real credential check (dispatcher.ts
 * runs `assertVisionCredentialPresent` as a separate step for that reason).
 * Kept as its own named interface — rather than an inline object type or a
 * `Pick<ProviderConfig, ...>` — so a stored `LlmProvider` settings record
 * cannot silently satisfy this gate just by having matching field names; see
 * the PR #157 bug class (a keyless cloud provider was treated as vision-ready
 * because it structurally matched, not because it could actually serve a
 * vision call).
 */
export interface VisionReadyConfig {
  visionModel: string;
  baseUrl: string;
  label: string;
}

/** Hard cap on image payload sent to a vision model. Vision providers reject
 * >10 MB payloads and the in-memory peak on a phone (base64 inflates by 33%,
 * then JSON.stringify duplicates it for the request body) can OOM the app.
 * Both share-target and in-app photo capture enforce this ceiling.
 *
 * Note: `quality: 0.6` on expo-camera caps JPEG compression but NOT
 * resolution — a 50 MP sensor can still produce >8 MB at q=0.6. So callers
 * MUST gate on `assertBase64UnderLimit` rather than trusting quality alone. */
export const MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024;

/** Throw a user-friendly LlmClientError if `base64` decodes to more than
 * `MAX_SHARED_IMAGE_BYTES`. Avoids materialising the binary — base64 length
 * × 0.75 is exact enough (off-by-≤2 bytes from padding `=`).
 *
 * Uses HTTP 413 (Payload Too Large) so `isPermanentError` correctly
 * classifies this as non-retryable — the image will never magically shrink. */
export function assertBase64UnderLimit(base64: string): void {
  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes > MAX_SHARED_IMAGE_BYTES) {
    const mb = Math.round(approxBytes / 1024 / 1024);
    const capMb = Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024);
    throw new LlmClientError(
      `Image is ${mb} MB — carnet caps at ${capMb} MB. Downscale or crop before sending.`,
      413,
    );
  }
}

/**
 * Every config precondition a vision call checks BEFORE touching the network,
 * in one place so a readiness probe and the real call can never disagree.
 * `ocrCardViaVision` calls this rather than repeating the three asserts, so a
 * caller that passes this is guaranteed to get past the same point at runtime.
 *
 * Order matters and is pinned by tests: vision model, then URL, then transport.
 * A fully blank config must report the vision model first.
 *
 * Throws the same `notConfigured`-flagged {@link LlmClientError} the real call
 * throws, so callers classify it with the existing predicates.
 */
export function assertVisionReady(
  config: VisionReadyConfig,
): { model: string; url: string } {
  const model = assertVisionModelConfigured(config.visionModel, config.label);
  const trimmed = assertUrlConfigured(config.baseUrl, config.label);
  const url = trimmed.replace(/\/+$/, "");
  assertHttpsOrLocal(url, config.label);
  return { model, url };
}

/**
 * Reject non-HTTPS provider URLs to prevent the API key from being sent
 * over cleartext. HTTPS is always allowed; plain http:// is allowed only for
 * the local / LAN dev + self-hosted loop (loopback, 10.x, 192.168.x) via
 * exact-host parsing in {@link isCredentialSafeUrl}. All other http:// URLs
 * throw.
 *
 * Both pre-merge clients shared this exact guard (`isCredentialSafeUrl`) —
 * OmniRoute's original message just never SAID the loopback/LAN exemption
 * existed ("...must use https:// to protect the API key"), which was
 * misleading about its own behavior. Both providers now state the true
 * guard; this is not a security change (verified: same predicate, same
 * outcomes either way), only a corrected message.
 */
export function assertHttpsOrLocal(trimmed: string, label: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
  throw new LlmClientError(
    `${label} URL must use https:// (or be a loopback/LAN address) to protect the API key`,
    0,
    // NOT `notConfigured` — that flag also disables the provider fallback
    // chain, and an insecure primary must still fall back to a working
    // secondary. See isInsecureTransportError.
    { insecureTransport: true },
  );
}

/** Throw not-configured when a resolved base URL is blank. `config.baseUrl`
 * is pre-resolved by the caller — the local backend's blank URL is defaulted
 * to the loopback address by dispatcher.ts before the config is built, so
 * this only ever actually fires for a provider (like OmniRoute) whose blank
 * URL has no sensible default. */
export function assertUrlConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LlmClientError(`${label} URL not configured — set it in Settings`, 0, {
      notConfigured: true,
    });
  }
  return trimmed;
}

/** Throw not-configured when a resolved text/chat model is blank. Mirrors
 * the local backend's original getModel() message exactly ("Local LLM model
 * not configured..."). OmniRoute's model always has a hard-coded default
 * substituted by dispatcher.ts before the config is built, so this never
 * actually fires for OmniRoute. */
export function assertModelConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LlmClientError(`${label} model not configured — set it in Settings`, 0, {
      notConfigured: true,
    });
  }
  return trimmed;
}

/** Throw not-configured when a resolved vision model is blank.
 *
 * OmniRoute originally had a DEDICATED getVisionModel() with its own
 * unbranded message ("Vision model not configured — set it in Settings"),
 * distinct from its getModel() text-model message. The local backend has no
 * separate vision concept — it reuses getModel() (and therefore the same
 * BRANDED "Local LLM model not configured..." message) for both text and
 * vision, because `config.visionModel` IS `config.model` for that backend.
 * Preserved exactly per origin rather than collapsed into one string. */
export function assertVisionModelConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    const message =
      label === "OmniRoute"
        ? "Vision model not configured — set it in Settings"
        : `${label} model not configured — set it in Settings`;
    throw new LlmClientError(message, 0, { notConfigured: true });
  }
  return trimmed;
}
