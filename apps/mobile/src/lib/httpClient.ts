/**
 * Shared HTTP-client hardening for carnet's two network clients —
 * lib/omniroute.ts (LLM gateway) and lib/karakeep.ts (export target).
 *
 * These helpers are the SECURITY SURFACE both clients must share exactly:
 * before this module they were hand-duplicated ("mirrors omniroute.ts"),
 * meaning a hardening fix could land in one client and silently miss the
 * other (2026-07-16 architecture-audit finding #4). Everything here is pure
 * and RN-import-free so the queue modules (lib/asyncQueueUtils.ts) can share
 * the redactor too.
 *
 * What deliberately STAYS in each client: its Error subclass name and
 * user-facing message strings (surfaced in UI and asserted by tests), the
 * 3-line HTTPS-or-LAN wrappers (the actual policy already lives in
 * lib/netAllowlist.isCredentialSafeUrl), and each API's response parsing.
 */

/**
 * Base class for both clients' errors. Carries the HTTP status so callers
 * classify transient (network/5xx) vs permanent (4xx) failures; status `0`
 * means no HTTP response ever arrived (DNS, TLS, refused, abort/timeout —
 * or a blank URL, see `notConfigured`).
 */
export class HttpError extends Error {
  readonly status: number;
  /** True when the failure is a missing/blank configuration (no URL set),
   * not a network failure. Status is still 0, but unlike a real timeout this
   * will NEVER succeed by retrying — the caller must surface it so the user
   * fixes Settings. */
  readonly notConfigured: boolean;
  constructor(
    message: string,
    status: number,
    opts?: { notConfigured?: boolean },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.notConfigured = opts?.notConfigured ?? false;
  }
}

/** Strip any "Bearer ..." substring from an error message so an API key never
 * lands in stored error logs or on-screen toasts. Also strips the
 * Authorization header form. The ONE canonical redactor — the queues'
 * persisted-error path uses it too (lib/asyncQueueUtils.ts). */
export function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/**
 * Build a sanitized HTTP-error detail string from a failing Response. Reads
 * the body as JSON and appends its message if present; swallows parse
 * failures because the status alone is enough signal. Understands both error
 * shapes the two backends produce: OpenAI-style `{error: {message}}`
 * (OmniRoute/LiteLLM) and flat `{error}` / `{message}` strings (Karakeep).
 */
export async function parseErrorBody(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? body.message);
    if (message) {
      detail += `: ${sanitizeErrorMessage(message)}`;
    }
  } catch {
    // ignore parse failure — status alone is enough
  }
  return detail;
}

/**
 * Run a network operation with a HARD timeout that ALWAYS settles.
 *
 * Covers the WHOLE operation — connect AND body read — not just fetch().
 * Two ways a request can hang past a bare fetch timeout: RN's fetch ignores
 * AbortController.abort() on a stuck TCP connect (unreachable tailnet host),
 * AND response.json() on a never-closing body (LiteLLM SSE) hangs after the
 * connect succeeds. Racing the entire `run()` against an independent
 * reject-timer bounds both; abort() is still fired best-effort to release
 * the socket.
 *
 * `makeTimeoutError` supplies the client-specific status-0 error (message
 * strings are user-facing and asserted by tests, so they stay per-client).
 */
export async function withTimeout<T>(
  ms: number,
  makeTimeoutError: (ms: number) => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* best-effort cancel */
      }
      reject(makeTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
