/**
 * Error type and classification predicates for the merged LLM client
 * (./llmClient). Split out of llmClient.ts as a move-only extraction —
 * see llmClient.ts's module comment for the full decomposition map.
 */

import { HttpError } from "./httpClient";

/**
 * Error thrown by this client. Carries the HTTP status so callers classify
 * between transient (network / 5xx — safe to queue and retry) and permanent
 * (4xx — auth / bad model / malformed request — surface to user, do NOT
 * retry blindly). Status `0` means a network-level failure (DNS, TLS,
 * connection refused, abort) — or a missing configuration, see
 * `notConfigured`.
 *
 * Named generically (not per-backend) because this class now serves every
 * provider — the generalization that used to live only in isPermanentError/
 * isNotConfiguredError (classifying via the shared HttpError base rather
 * than a backend-specific subclass) is now reflected in the class itself.
 */
export class LlmClientError extends HttpError {
  constructor(
    message: string,
    status: number,
    opts?: { notConfigured?: boolean; insecureTransport?: boolean },
  ) {
    super(message, status, opts);
    this.name = "LlmClientError";
  }
}

/** True for HTTP statuses that indicate a permanent failure — caller should
 * NOT enqueue these for automatic retry. Classifies via the shared HttpError
 * base (not LlmClientError specifically) so any HttpError subclass is
 * classified correctly without callers needing per-backend predicates. */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.status >= 400 && err.status < 500;
}

/** True when the request failed because the provider is not configured
 * (blank URL or blank model). Distinct from a transient network status-0
 * error: retrying/queuing is pointless until the user fixes Settings, so
 * the caller should surface this instead. */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof HttpError && err.notConfigured;
}

/** True when the request was refused because credentials would have travelled
 * over cleartext to a non-local host ({@link assertVisionReady}'s transport
 * check). Like not-configured, only a Settings change can fix it — but it is
 * deliberately NOT the same flag: `isNotConfiguredError` suppresses the
 * provider fallback chain, and an insecure primary must keep falling back to a
 * working secondary. Callers that only need "is retrying pointless?" (card-scan
 * outcome copy) consult this; the fallback chain does not. */
export function isInsecureTransportError(err: unknown): boolean {
  return err instanceof HttpError && err.insecureTransport;
}

/** Status-0 timeout error for {@link withTimeout} — the timeout MECHANISM is
 * shared (lib/httpClient.ts), so hardening fixes reach every caller.
 *
 * OmniRoute's original timeout message ended with a Tailscale connectivity
 * hint (it's usually reached over a tailnet); the local backend's did not
 * (it's a loopback/LAN server, not tailnet-routed) — preserved per provider
 * rather than merged into one wording. */
export function timeoutError(label: string, ms: number): LlmClientError {
  const tailscaleHint =
    label === "OmniRoute" ? " Check your connection (Tailscale?)." : "";
  return new LlmClientError(
    `${label} unreachable — timed out after ${Math.round(ms / 1000)}s.${tailscaleHint}`,
    0,
  );
}
