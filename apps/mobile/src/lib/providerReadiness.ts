/**
 * Local-provider readiness hint (issue #85, re-specced UX: warn, don't
 * block). A "local" provider — Relais, or any custom entry pointed at a
 * loopback/LAN base URL — routinely isn't running yet: the user hasn't
 * started it, or it's on a different network right now. Selecting it must
 * stay allowed (captures fall back to the offline queue and send once it's
 * reachable — see `lib/queue.ts`), so this module only classifies state for
 * a warning hint, never a block.
 *
 * Deliberately separate from `dispatcher.ts`'s enrichment-time checks:
 * this is a pre-emptive settings-screen probe, not a call-time failure
 * classification.
 */
import { isLocalNetworkUrl } from "./netAllowlist";
import { healthCheck, type HealthResult } from "./llmClient";

/** True when `provider` points at a loopback/LAN base URL — i.e. the kind
 * of endpoint that only answers when something is running on this device or
 * network, as opposed to an always-on cloud API.
 *
 * A blank base URL counts as local ONLY for the `relais` preset — mirrors
 * `LlmProviderSection.tsx`'s `canTestConnection` precedent exactly (its
 * `isRelais` check): a blank Relais URL and its loopback default
 * (`llmClient.ts`'s `DEFAULT_LOCAL_LLM_URL`, which `healthCheck` itself
 * substitutes for ANY blank base URL) are the same endpoint either way, so
 * classifying by id alone is enough — no need to duplicate that literal
 * here. Every OTHER provider with a blank base URL (including every custom
 * entry) is simply not local — it's unconfigured, and treating it as
 * loopback-probeable would be the same misleading-probe hazard
 * `canTestConnection`'s comment documents for OmniRoute. */
export function isLocalProvider(provider: { id: string; baseUrl: string }): boolean {
  const trimmed = provider.baseUrl.trim();
  if (!trimmed) return provider.id === "relais";
  return isLocalNetworkUrl(trimmed);
}

export type LocalReadinessState = "ok" | "unreachable";

/** Probes one local provider's reachability via the same `healthCheck` the
 * "Test connection" button uses. Collapses every non-"ok" `HealthResult`
 * ("unreachable", "unauthorized", "blocked-cleartext", "unsafe-url",
 * "untrusted-tls") to "unreachable" — this hint only ever needs to say
 * "start it" or say nothing; the granular reasons stay in Test Connection's
 * own result display. "untrusted-tls" collapses here too: a self-signed
 * cert on a local server is still "not usable right now" from this hint's
 * point of view, and the generic queueing copy isn't wrong for it — the
 * precise "certificate this device doesn't trust" explanation belongs in
 * Test Connection's own display, not this pre-emptive row hint. NEVER
 * throws: a rejected/thrown `healthCheck` (network module hiccup, a test
 * double that misbehaves) reads as "unreachable" rather than crashing the
 * fire-and-forget probe effect that calls this.
 *
 * `allowInsecureTransport` (#176) forwards the resolved provider's consent
 * flag into `healthCheck`'s probe-only gate — without it, a provider the
 * user had already consented to for enrichment (an http:// Tailscale
 * endpoint, say) would still fail THIS probe and permanently show the
 * "Not reachable — make sure it's running" hint even while enrichment
 * against that exact endpoint was succeeding. Defaults to `false` so a
 * caller with no provider in hand (there is none today, but the signature
 * shouldn't force one) keeps today's behavior. */
export async function probeLocalProviderReachability(
  baseUrl: string,
  apiKey: string,
  allowInsecureTransport = false,
): Promise<LocalReadinessState> {
  try {
    const result: HealthResult = await healthCheck(baseUrl, apiKey, allowInsecureTransport);
    return result === "ok" ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Copy for a local provider's row. `undefined` covers "not yet probed"
 * (probe still in flight, or hasn't started) — same as "ok": no hint until
 * there's a confirmed failure to report, so a slow probe never flashes a
 * false warning. Keeps the wording factual (never "disabled" — selection
 * stays allowed) and names the actual fallback behavior (queueing), not a
 * generic "try again" that doesn't describe what the app does.
 *
 * Deliberately generic rather than "start Relais" — this hint fires for any
 * local provider, including a custom entry pointed at a LAN LLM server that
 * isn't Relais at all (Ollama, LM Studio, …), and naming the wrong app would
 * be actively wrong advice for those. */
export function localProviderHint(state: LocalReadinessState | undefined): string | null {
  if (state !== "unreachable") return null;
  return "Not reachable — make sure it's running on this device or network. Captures will queue until it is.";
}
