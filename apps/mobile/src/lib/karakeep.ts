/**
 * Karakeep export client for carnet.
 *
 * Posts notes as text bookmarks to a self-hosted Karakeep instance's REST
 * API (`{instanceUrl}/api/v1`). Bearer auth — the user generates the API key
 * in the Karakeep UI (User Settings → API Keys) and stores it in carnet
 * Settings (SecureStore). Reads `karakeepUrl` + `karakeepApiKey` from settings.
 *
 * v1 is text-only: the note's markdown body becomes the bookmark text; tags
 * are attached in a SEPARATE call (Karakeep does not accept tags inline on the
 * create call). Attachments/assets are NOT uploaded in v1.
 *
 * The client infrastructure (KarakeepError, withTimeout, assertHttpsOrLocal,
 * sanitizeErrorMessage, parseErrorBody) mirrors omniroute.ts so the two
 * network clients share the same hardening: hard whole-operation timeout,
 * HTTPS enforcement to protect the key, and Bearer-token redaction in errors.
 */

import { getSettings } from "./settings";

/**
 * Error thrown by the Karakeep client. Carries the HTTP status so callers can
 * classify transient (network / 5xx) vs permanent (4xx) failures. Status `0`
 * means a network-level failure (DNS, TLS, connection refused, abort, or a
 * blank URL — see `notConfigured`).
 */
export class KarakeepError extends Error {
  readonly status: number;
  /** True when the failure is a missing/blank configuration (no URL set), not
   * a network failure. Status is still 0 (no HTTP response), but unlike a real
   * timeout this will NEVER succeed by retrying — the caller must surface it so
   * the user fixes Settings. */
  readonly notConfigured: boolean;
  constructor(
    message: string,
    status: number,
    opts?: { notConfigured?: boolean },
  ) {
    super(message);
    this.name = "KarakeepError";
    this.status = status;
    this.notConfigured = opts?.notConfigured ?? false;
  }
}

/** True when the request failed because Karakeep is not configured (blank
 * URL). Distinct from a transient network status-0 error: the caller should
 * surface this rather than retry. */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof KarakeepError && err.notConfigured;
}

// Hard ceiling on any single Karakeep request. Kept short so an unreachable
// host fails fast instead of spinning.
const FETCH_TIMEOUT_MS = 20_000;

/** Strip any "Bearer ..." substring from an error message so the API key
 * never lands in stored error logs or on-screen toasts. Also strip the
 * Authorization header form just in case. */
function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/**
 * Reject non-HTTPS Karakeep URLs to prevent the API key from being sent over
 * cleartext. Localhost / loopback / RFC1918 (10.x) are allowed for dev — the
 * host-on-LAN dev loop relies on plain HTTP. All other http:// URLs throw.
 */
function assertHttpsOrLocal(trimmed: string): void {
  if (/^https:\/\//i.test(trimmed)) return;
  if (/^http:\/\/(localhost|127\.0\.0\.1|10\.)/i.test(trimmed)) return;
  throw new KarakeepError(
    "Karakeep URL must use https:// to protect the API key",
    0,
  );
}

/**
 * Build a sanitized HTTP-error detail string from a failing Response. Reads
 * the body as JSON and appends a message field if present; swallows parse
 * failures because the status alone is enough signal in that case.
 */
async function parseErrorBody(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`;
  try {
    const errBody = (await response.json()) as {
      error?: string;
      message?: string;
    };
    const message = errBody.error ?? errBody.message;
    if (message) {
      detail += `: ${sanitizeErrorMessage(message)}`;
    }
  } catch {
    // ignore parse failure — status alone is enough
  }
  return detail;
}

/**
 * Run a network operation with a HARD timeout that ALWAYS settles. Covers the
 * WHOLE operation — connect AND body read — by racing `run()` against an
 * independent reject-timer; abort() is fired best-effort to release the
 * socket. Rejects with a status-0 KarakeepError on timeout so callers'
 * network-error paths fire.
 */
async function withTimeout<T>(
  ms: number,
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
      reject(
        new KarakeepError(
          `Karakeep unreachable — timed out after ${Math.round(ms / 1000)}s. Check your connection.`,
          0,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read the Karakeep URL + API key from settings. Throws a not-configured
 * KarakeepError when the URL is blank so the caller surfaces it instead of
 * hitting an endpoint that can't exist.
 */
async function getKarakeepConfig(): Promise<{ url: string; apiKey: string }> {
  const settings = await getSettings();
  const url = settings.karakeepUrl.trim();
  if (!url) {
    throw new KarakeepError(
      "Karakeep URL not configured — set it in Settings",
      0,
      { notConfigured: true },
    );
  }
  return { url, apiKey: settings.karakeepApiKey ?? "" };
}

/** Authorization header for a Bearer key, omitted entirely when blank. */
function authHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Create a text bookmark in Karakeep. POSTs to `/api/v1/bookmarks` with a
 * `{type:"text", text, title?, createdAt?}` body. Returns the new bookmark's
 * id, which the caller writes back into the note frontmatter for idempotency.
 *
 * Tags are NOT settable here — attach them via `attachTags` after this returns.
 */
export async function createTextBookmark(input: {
  text: string;
  title?: string;
  createdAt?: string;
}): Promise<{ id: string }> {
  const { url, apiKey } = await getKarakeepConfig();
  const trimmed = url.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const endpoint = `${trimmed}/api/v1/bookmarks`;
  const body = JSON.stringify({
    type: "text",
    text: input.text,
    ...(input.title ? { title: input.title } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });

  return await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader(apiKey),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      // Timeout already arrives as a shaped KarakeepError — don't double-wrap.
      if (e instanceof KarakeepError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new KarakeepError(
        `Karakeep network error — ${sanitizeErrorMessage(raw)}`,
        0,
      );
    }

    if (!response.ok) {
      throw new KarakeepError(
        `Karakeep error — ${await parseErrorBody(response)}`,
        response.status,
      );
    }

    const json = (await response.json()) as { id?: unknown };
    if (typeof json.id !== "string" || json.id.length === 0) {
      throw new KarakeepError(
        "Karakeep returned a malformed bookmark (no id)",
        response.status,
      );
    }
    return { id: json.id };
  });
}

/**
 * Attach tags to an existing Karakeep bookmark. POSTs to
 * `/api/v1/bookmarks/{id}/tags` with `{tags: [{tagName, attachedBy:"human"}]}`.
 * No-ops (and skips the fetch) when there are no tags to attach.
 */
export async function attachTags(
  bookmarkId: string,
  tagNames: readonly string[],
): Promise<void> {
  if (tagNames.length === 0) return;
  const { url, apiKey } = await getKarakeepConfig();
  const trimmed = url.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const endpoint = `${trimmed}/api/v1/bookmarks/${bookmarkId}/tags`;
  const body = JSON.stringify({
    tags: tagNames.map((tagName) => ({ tagName, attachedBy: "human" })),
  });

  await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader(apiKey),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof KarakeepError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new KarakeepError(
        `Karakeep network error — ${sanitizeErrorMessage(raw)}`,
        0,
      );
    }

    if (!response.ok) {
      throw new KarakeepError(
        `Karakeep error — ${await parseErrorBody(response)}`,
        response.status,
      );
    }
  });
}
