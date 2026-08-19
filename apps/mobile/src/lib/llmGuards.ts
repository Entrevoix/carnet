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
 * `Pick<ProviderConfig, ...>` — to document this contract at the definition
 * site; `ProviderConfig extends VisionReadyConfig` pins the coupling so a
 * field rename breaks here instead of drifting silently. Note TypeScript's
 * structural typing means other shapes (e.g. a stored `LlmProvider` record)
 * WILL still satisfy this parameter type — the interface documents the
 * readiness-vs-credential distinction, it does not enforce it; see the
 * PR #157 bug class (a keyless cloud provider treated as vision-ready).
 */
export interface VisionReadyConfig {
  visionModel: string;
  baseUrl: string;
  label: string;
  /** Per-provider consent (#176) to bypass the transport gate for THIS
   * provider's baseUrl — see llmProviders.ts's `allowInsecureTransport` for
   * the full contract. `undefined`/absent reads as `false`, so every
   * existing VisionReadyConfig/ProviderConfig literal in this codebase's
   * tests is unaffected by this field's addition. */
  allowInsecureTransport?: boolean;
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
  assertHttpsOrLocal(url, config.label, config.allowInsecureTransport ?? false);
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
 *
 * UNCONDITIONAL BY DEFAULT — fires regardless of whether a credential is
 * actually present. This is deliberate for every call site that reaches
 * this function directly: `executeChat` (llmHttp.ts, every enrich/chat/
 * vision call) and `assertVisionReady` below (→ `ocrCardViaVision`) are all
 * CONTENT-BEARING — they send the user's note text or an image regardless of
 * whether a key rides along, and per the #176 security review a keyless
 * `http://public-host` must still be refused for those calls (note content,
 * not just a key, would otherwise leak in the clear). Call sites that are
 * PROBE-ONLY (no user content, e.g. `listModels`/`healthCheck` in
 * llmClient.ts) do NOT call this directly — they call
 * {@link assertHttpsOrLocalForProbe} / go through `isCredentialSafeUrlForProbe`
 * instead, which skips the gate entirely when no key would be sent.
 *
 * `allowInsecureTransport` (#176, default `false`) is the ONE other escape
 * hatch: explicit, per-provider, user-granted consent (see
 * llmProviders.ts's field of the same name) to send THIS provider's
 * credential and content over plain http:// to a URL the gate would
 * otherwise refuse — e.g. a Tailscale hostname. It bypasses the check
 * entirely when `true`, same as the gate passing on its own; callers thread
 * it from the resolved `ProviderConfig`/`VisionReadyConfig`, never from a
 * raw boolean literal, so consent always traces back to a specific entry
 * the user opted in.
 */
export function assertHttpsOrLocal(
  trimmed: string,
  label: string,
  allowInsecureTransport = false,
): void {
  if (allowInsecureTransport) return;
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

/**
 * PROBE-ONLY variant of the transport gate (#176): fires
 * {@link assertHttpsOrLocal}'s exact check, but ONLY when `apiKey` is
 * non-blank AND `allowInsecureTransport` (the resolved provider's #176
 * consent flag, when the caller has one in hand) is false. `listModels`
 * (llmClient.ts) is a reachability/catalog probe — it carries no note
 * content, and every existing Authorization construction in this codebase
 * is already key-conditional (`apiKey ? {Authorization...} : {}`), so a
 * BLANK key sent to this endpoint transmits no credential at all. Refusing
 * a keyless probe to a plaintext public host protects nothing — there is
 * nothing secret in flight — and the #176 review found this was blocking a
 * legitimate keyless-catalog-browse case (e.g. an open, self-hosted
 * OpenAI-compatible gateway with no auth configured, reachable only over
 * http://).
 *
 * `allowInsecureTransport` closes a gap the initial #176 landing left open:
 * a KEYED probe (Test Connection / Browse Models with a real key configured)
 * against a provider the user had already consented to for enrichment still
 * hit this gate, because the probe call sites didn't have the consent flag
 * to forward. Both flags are independent escape hatches — a blank key needs
 * no consent, and consent bypasses the gate regardless of key — so either
 * one being true is enough.
 *
 * When neither escape hatch applies, this is byte-identical to
 * `assertHttpsOrLocal` — a real credential must still never cross an unsafe
 * URL without either the caller having nothing secret to send or the user
 * having explicitly said so for this provider. */
export function assertHttpsOrLocalForProbe(
  trimmed: string,
  apiKey: string,
  label: string,
  allowInsecureTransport = false,
): void {
  if (!apiKey.trim()) return;
  assertHttpsOrLocal(trimmed, label, allowInsecureTransport);
}

/**
 * Non-throwing sibling of {@link assertHttpsOrLocalForProbe}, for
 * `healthCheck` (llmClient.ts), which must never throw — see that
 * function's own doc for why a connectivity check reports a status instead
 * of crashing the "Test Connection" button. Same key-conditional,
 * consent-aware probe-only classification: a blank `apiKey` means no
 * credential is ever transmitted, and `allowInsecureTransport` is the
 * resolved provider's #176 consent flag — either being true skips the
 * gate. */
export function isCredentialSafeUrlForProbe(
  trimmed: string,
  apiKey: string,
  allowInsecureTransport = false,
): boolean {
  if (!apiKey.trim()) return true;
  if (allowInsecureTransport) return true;
  return isCredentialSafeUrl(trimmed);
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
