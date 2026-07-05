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

import { isCredentialSafeUrl } from "./netAllowlist";
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

// Hard ceiling on a single Karakeep JSON request. Kept short so an unreachable
// host fails fast instead of spinning.
const FETCH_TIMEOUT_MS = 20_000;

// Asset uploads ship file bytes over a (often LAN/tailnet) link, so they get a
// more generous ceiling than the small JSON calls.
const ASSET_FETCH_TIMEOUT_MS = 60_000;

// assetType used when attaching an uploaded asset to a bookmark. "userUploaded"
// is the generic "the user attached this file" slot in Karakeep's asset enum —
// it accepts images and non-images alike, but Karakeep does NOT render a
// userUploaded asset on a TEXT bookmark (stored, but hidden in the UI).
const ATTACH_ASSET_TYPE = "userUploaded";

// The note's FIRST image is attached as "bannerImage" instead — Karakeep DOES
// render that as the bookmark's cover on a text bookmark (verified against a
// live instance 2026-06-14). Only one banner shows, so remaining images + all
// non-image files stay userUploaded (attached but not displayed).
export const BANNER_ASSET_TYPE = "bannerImage";

/**
 * Relative URL path that serves an uploaded asset's bytes, for embedding INLINE
 * in a bookmark's markdown body (`![](…)`). Verified against a live instance:
 * `GET /api/assets/{id}` returns the image, and Karakeep's read-only markdown
 * renderer (MarkdownReadonly, used for a text bookmark's `content.text`) renders
 * images with no source restriction — so an `<img src="/api/assets/{id}">`
 * loads via the viewer's web session.
 *
 * RELATIVE on purpose: it resolves against whatever origin the user opens
 * Karakeep from, and rides the browser session cookie — no API key in the body,
 * and no dependence on the configured base URL matching the viewing origin.
 */
export function assetContentPath(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

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
 * cleartext. HTTPS is always allowed; plain http:// is allowed only for the
 * local / LAN dev + self-hosted loop (loopback, 10.x, 192.168.x) via
 * exact-host parsing in {@link isCredentialSafeUrl}. All other http:// URLs
 * throw.
 */
function assertHttpsOrLocal(trimmed: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
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
 * Core Karakeep request. Reads config (throwing not-configured on a blank URL),
 * enforces HTTPS, trims trailing slashes, injects the Bearer header, and runs
 * the fetch under a hard whole-operation timeout. Network failures become a
 * status-0 KarakeepError (sanitized); non-2xx becomes a KarakeepError carrying
 * the HTTP status. Returns the raw ok `Response` so each caller parses its own
 * body. Body + extra headers are caller-supplied, so this serves both the JSON
 * endpoints and the multipart asset upload.
 */
async function karakeepFetch(
  path: string,
  init: {
    method: "POST" | "PATCH";
    body: BodyInit;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const { url, apiKey } = await getKarakeepConfig();
  const trimmed = url.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const endpoint = `${trimmed}${path}`;

  // Only the small JSON calls go through here now; the multipart asset upload
  // uses karakeepUpload (XHR) with its own longer ceiling.
  return await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: init.method,
        headers: { ...authHeader(apiKey), ...(init.headers ?? {}) },
        body: init.body,
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

    return response;
  });
}

/**
 * JSON-request convenience over {@link karakeepFetch}: sets the JSON
 * Content-Type and serializes the body. Returns the raw ok `Response` so each
 * caller parses its own body shape.
 */
async function karakeepSendJson(
  path: string,
  method: "POST" | "PATCH",
  jsonBody: unknown,
): Promise<Response> {
  return await karakeepFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jsonBody),
  });
}

/** Append `: <message>` parsed from a JSON error body (`{error|message}`), or
 * "" when the body is empty / non-JSON. Sync sibling of parseErrorBody for the
 * XHR upload path (which exposes responseText, not a Response). */
function parseErrorBodyText(body: string): string {
  if (!body) return "";
  try {
    const json = JSON.parse(body) as { error?: string; message?: string };
    const message = json.error ?? json.message;
    return message ? `: ${sanitizeErrorMessage(message)}` : "";
  } catch {
    return "";
  }
}

/**
 * Multipart upload via **XMLHttpRequest** instead of fetch. RN's `fetch`
 * (whatwg-fetch) builds a `Request`, and for a FormData/multipart body that
 * lazily loads a Blob polyfill module which is broken on Hermes — it references
 * the absent `SharedArrayBuffer` global, and (once that is shimmed) a further
 * `Cannot read property 'get' of undefined` — crashing the app the FIRST time a
 * multipart fetch runs (confirmed on-device exporting Karakeep assets; all unit
 * tests mock fetch, so it never surfaced). `XMLHttpRequest` is React Native's
 * native networking (what fetch wraps for non-multipart requests) and serializes
 * a FormData with `{uri,name,type}` parts natively, bypassing that module.
 *
 * Reuses the same hardening as karakeepFetch: not-configured throw on a blank
 * URL, HTTPS-or-LAN enforcement, Bearer auth, a hard whole-operation timeout,
 * and Bearer-token redaction in errors. Resolves with the raw status + body text
 * (the caller parses its own JSON); rejects with a KarakeepError carrying the
 * HTTP status (4xx/5xx) or status 0 (network/timeout).
 */
async function karakeepUpload(
  path: string,
  form: FormData,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const { url, apiKey } = await getKarakeepConfig();
  const trimmed = url.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);
  const endpoint = `${trimmed}${path}`;

  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const xhr = new XMLHttpRequest();
    try {
      xhr.open("POST", endpoint);
      const auth = authHeader(apiKey).Authorization;
      // No Content-Type header — XHR derives the multipart boundary from the
      // FormData body, exactly as the fetch path relied on.
      if (auth) xhr.setRequestHeader("Authorization", auth);
      xhr.timeout = timeoutMs;
      xhr.onload = () =>
        done(() => {
          const body = xhr.responseText ?? "";
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ status: xhr.status, body });
          } else {
            reject(
              new KarakeepError(
                `Karakeep error — HTTP ${xhr.status}${parseErrorBodyText(body)}`,
                xhr.status,
              ),
            );
          }
        });
      xhr.onerror = () =>
        done(() =>
          reject(
            new KarakeepError(
              `Karakeep network error — ${sanitizeErrorMessage(xhr.responseText || "upload failed")}`,
              0,
            ),
          ),
        );
      xhr.ontimeout = () =>
        done(() =>
          reject(
            new KarakeepError(
              `Karakeep unreachable — timed out after ${Math.round(timeoutMs / 1000)}s. Check your connection.`,
              0,
            ),
          ),
        );
      // RN dispatches exactly one terminal event (load|error|timeout|abort); an
      // abort fires ONLY `onabort` (not `onerror`), so handle it too or the
      // promise could never settle. Nothing here calls xhr.abort(), so this is
      // defensive against a native/teardown abort.
      xhr.onabort = () =>
        done(() => reject(new KarakeepError("Karakeep upload aborted", 0)));
      xhr.send(form);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      done(() =>
        reject(
          new KarakeepError(`Karakeep network error — ${sanitizeErrorMessage(raw)}`, 0),
        ),
      );
    }
  });
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
  const response = await karakeepSendJson("/api/v1/bookmarks", "POST", {
    type: "text",
    text: input.text,
    ...(input.title ? { title: input.title } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });

  const json = (await response.json()) as { id?: unknown };
  if (typeof json.id !== "string" || json.id.length === 0) {
    throw new KarakeepError(
      "Karakeep returned a malformed bookmark (no id)",
      response.status,
    );
  }
  return { id: json.id };
}

/**
 * Update an EXISTING text bookmark in place. PATCHes `/api/v1/bookmarks/{id}`
 * with the changed fields (`text`, `title?`, `createdAt?`) so a re-export
 * refreshes the same bookmark instead of creating a duplicate. A `404` surfaces
 * as a status-404 KarakeepError so the caller can fall back to creating a fresh
 * bookmark when the stored id was deleted server-side.
 *
 * The PATCH returns the updated bookmark (which carries `id`), but a `204`/empty
 * or otherwise idless body is tolerated — we already know the id, so a
 * successful update isn't failed on response shape.
 */
export async function updateTextBookmark(
  bookmarkId: string,
  input: { text: string; title?: string; createdAt?: string },
): Promise<{ id: string }> {
  const response = await karakeepSendJson(
    `/api/v1/bookmarks/${encodeURIComponent(bookmarkId)}`,
    "PATCH",
    {
      text: input.text,
      ...(input.title ? { title: input.title } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  );

  const json = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  return {
    id: typeof json?.id === "string" && json.id.length > 0 ? json.id : bookmarkId,
  };
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
  await karakeepSendJson(
    `/api/v1/bookmarks/${encodeURIComponent(bookmarkId)}/tags`,
    "POST",
    { tags: tagNames.map((tagName) => ({ tagName, attachedBy: "human" })) },
  );
}

/**
 * Upload a file to Karakeep as an asset. POSTs multipart/form-data to
 * `/api/v1/assets` with the file under the `file` field (the field name Karakeep
 * expects). Returns the new `assetId`, which {@link attachAssetToBookmark} then
 * links to a bookmark.
 *
 * The file part uses the React Native `{ uri, name, type }` form. The upload
 * goes through {@link karakeepUpload} (XMLHttpRequest, NOT fetch): RN's native
 * networking streams the uri (a `file://` sandbox path or a SAF `content://`
 * URI) and derives the multipart boundary itself, so NO Content-Type header is
 * set here. Gets the longer asset timeout since it ships bytes over the network.
 * (VoiceButton's Whisper upload uses the same `{uri,name,type}` part shape but
 * still posts via `fetch` — it shares the latent Hermes crash karakeepUpload
 * works around, and needs the same XHR migration as a follow-up.)
 */
export async function uploadAsset(input: {
  uri: string;
  mime: string;
  filename: string;
}): Promise<{ assetId: string }> {
  const form = new FormData();
  form.append("file", {
    uri: input.uri,
    name: input.filename,
    type: input.mime,
  } as unknown as Blob);

  const { status, body } = await karakeepUpload(
    "/api/v1/assets",
    form,
    ASSET_FETCH_TIMEOUT_MS,
  );

  // Spec response is { assetId, contentType, size, fileName }; some versions/
  // forks key the new asset's id as `id` instead, so accept either. The parse
  // is guarded so a non-JSON 2xx yields the friendly malformed-asset error
  // rather than a raw SyntaxError.
  let json: { assetId?: unknown; id?: unknown } = {};
  try {
    json = JSON.parse(body) as { assetId?: unknown; id?: unknown };
  } catch {
    // non-JSON body → falls through to the malformed-asset error below
  }
  const assetId =
    typeof json.assetId === "string" && json.assetId.length > 0
      ? json.assetId
      : typeof json.id === "string" && json.id.length > 0
        ? json.id
        : "";
  if (!assetId) {
    throw new KarakeepError(
      "Karakeep returned a malformed asset (no assetId)",
      status,
    );
  }
  return { assetId };
}

/**
 * Attach an already-uploaded asset to an EXISTING bookmark. POSTs to
 * `/api/v1/bookmarks/{id}/assets` with `{ id: assetId, assetType }` — note the
 * body field is `id` (the ASSET id), not `assetId`. Defaults assetType to
 * `userUploaded` (see ATTACH_ASSET_TYPE).
 */
export async function attachAssetToBookmark(
  bookmarkId: string,
  assetId: string,
  assetType: string = ATTACH_ASSET_TYPE,
): Promise<void> {
  await karakeepSendJson(
    `/api/v1/bookmarks/${encodeURIComponent(bookmarkId)}/assets`,
    "POST",
    { id: assetId, assetType },
  );
}
