/**
 * URL preview fetcher for the share-target link path.
 *
 * Given a URL, fetch the raw HTML and extract a small set of
 * structured fields (`<title>`, `og:*`, `<meta name="description">`,
 * first `<p>`) so the LLM has real page content to summarize from
 * instead of guessing from the URL slug.
 *
 * Design decisions:
 *   - **Never throws.** All failure modes (invalid URL, network error,
 *     timeout, non-200, non-HTML, parse failure) collapse to `null`
 *     so the caller can fall back to the URL-string-only prompt.
 *   - **8-second timeout.** Faster than the 60s chat-completion budget
 *     because preview is best-effort — better to skip it than block
 *     the user.
 *   - **256 KB body cap.** RN's fetch doesn't expose response streaming
 *     cleanly; we read the full text and slice. The cap is well above
 *     a typical `<head>` block.
 *   - **Regex parsing, not DOM.** No DOM available in RN, and the
 *     surface we need is tiny (a handful of tags). Falls back to null
 *     gracefully on weird markup.
 *   - **Mozilla UA.** Many sites 403 the default RN fetch UA. We
 *     identify carnet in the comment portion for honest reporting.
 *
 * Threat model: page content may contain prompt-injection attempts
 * (`<title>Ignore previous instructions...</title>`). The caller MUST
 * thread the preview through the `<USER_INPUT>` envelope so the
 * existing INJECTION_GUARD covers it.
 */

const FETCH_TIMEOUT_MS = 8_000;
/** Body cap measured in UTF-16 code units (JS `string.length`), NOT
 * bytes — a multibyte-heavy page can occupy ~2× this in actual bytes,
 * but the head we care about always sits in the first few thousand
 * chars regardless of encoding. */
const MAX_BODY_CHARS = 256 * 1024;
const FIELD_CHAR_LIMIT = 500;
const USER_AGENT =
  "Mozilla/5.0 (compatible; carnet/0.2; +https://github.com/Entrevoix/carnet)";

export interface UrlPreview {
  /** Best of `<title>` and `og:title`. */
  title: string;
  /** `og:description`, `twitter:description`, or first `<p>` text. */
  description: string;
  /** `og:site_name` or hostname. */
  siteName: string;
  /** From the response `content-type` header. */
  contentType: string;
}

/** Maximum valid Unicode code point. `String.fromCodePoint` throws
 * `RangeError` for anything above this, so numeric entities are
 * clamp-checked rather than passed through blindly. */
const MAX_CODE_POINT = 0x10ffff;

/** Decode the most common HTML entities. We don't pull in a full
 * decoder because the fields we extract are short and predictable.
 * Out-of-range numeric entities (`&#1114112;` and friends) decode to
 * the empty string instead of bubbling a `RangeError`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = parseInt(code, 10);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CODE_POINT) return "";
      return String.fromCodePoint(n);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = parseInt(hex, 16);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CODE_POINT) return "";
      return String.fromCodePoint(n);
    });
}

/** Collapse whitespace and trim to the per-field limit. */
function clean(s: string): string {
  const collapsed = decodeEntities(s).replace(/\s+/g, " ").trim();
  return collapsed.length > FIELD_CHAR_LIMIT
    ? collapsed.slice(0, FIELD_CHAR_LIMIT).trimEnd()
    : collapsed;
}

/** Find the first match of a regex; return `clean()`-ed capture group 1
 * or empty string. Case-insensitive by convention at the call site. */
function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  if (!m || typeof m[1] !== "string") return "";
  return clean(m[1]);
}

/** Extract a `<meta>` value where the attribute order may be
 * `property|name="X" content="Y"` OR `content="Y" property|name="X"`.
 * Both shapes are common in the wild. Quote characters are captured
 * and backreferenced so mismatched pairs (`content="foo'`) don't
 * match — protects against unbalanced markup. */
function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // attr-first: <meta property="og:title" content="...">
  // Capture group 1 = key quote, 2 = key, 3 = content quote, 4 = content value.
  const a = new RegExp(
    `<meta[^>]*(?:property|name)\\s*=\\s*(["'])${escaped}\\1[^>]*content\\s*=\\s*(["'])([^"']*)\\2`,
    "i",
  );
  const matchA = html.match(a);
  if (matchA && typeof matchA[3] === "string") {
    const cleaned = clean(matchA[3]);
    if (cleaned) return cleaned;
  }
  // content-first: <meta content="..." property="og:title">
  const b = new RegExp(
    `<meta[^>]*content\\s*=\\s*(["'])([^"']*)\\1[^>]*(?:property|name)\\s*=\\s*(["'])${escaped}\\3`,
    "i",
  );
  const matchB = html.match(b);
  if (matchB && typeof matchB[2] === "string") {
    return clean(matchB[2]);
  }
  return "";
}

/** Pull the textual content of the first `<p>` tag, stripping nested
 * tags. Used only as a last-resort description fallback.
 *
 * The opening-tag regex is `<p` then either nothing or a whitespace-
 * led attribute block — written as `(?:\s[^>]*)?` so we cleanly
 * consume the entire opening tag before starting to capture the body.
 * A loose `<p[^>]*>` would also work but `<p` followed by another
 * letter (e.g. `<pre>`) would match it. */
function firstParagraph(html: string): string {
  const m = html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i);
  if (!m || typeof m[1] !== "string") return "";
  const stripped = m[1].replace(/<[^>]+>/g, " ");
  return clean(stripped);
}

/** SSRF guard: hosts that should NEVER be reached by a URL preview
 * fetch, even though the device's network position could otherwise
 * reach them.
 *
 *   - loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) — pointing
 *     a preview at the user's own device serves no legitimate purpose
 *     and exposes any locally-bound dev servers.
 *   - link-local cloud metadata (`169.254.169.254`) — the AWS/GCP/Azure
 *     instance metadata service. Hardcoded high-value SSRF target.
 *
 * General RFC1918 private ranges (`10.*`, `172.16-31.*`, `192.168.*`)
 * are deliberately NOT blocked: the user may legitimately bookmark
 * self-hosted services on their LAN. The user's threat model here is
 * "I am sharing my own URLs", not "an attacker is pivoting through
 * my shares". A blocked-hosts list lives at the boundary; a wider
 * deny-list belongs in a future explicit setting. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (h === "169.254.169.254") return true;
  return false;
}

/** Internal: do the fetch with a timeout. Throws AbortError on
 * timeout, propagates other fetch errors. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the URL and extract a structured preview. Returns null on any
 * failure — invalid URL, network error, timeout, non-200, non-HTML
 * content type, or parse error. Never throws.
 */
export async function fetchUrlPreview(url: string): Promise<UrlPreview | null> {
  // Validate the URL first so we don't waste a network round-trip on
  // garbage input.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only http(s). file://, content://, javascript: etc. are out.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  // SSRF guard — see isBlockedHost JSDoc for the threat model.
  if (isBlockedHost(parsed.hostname)) {
    return null;
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return null;
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  // Cap memory: many sites serve multi-MB HTML; the head we care about
  // sits in the first few KB.
  const html = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;

  try {
    const ogTitle = metaContent(html, "og:title");
    const twitterTitle = metaContent(html, "twitter:title");
    const titleTag = firstMatch(html, /<title[^>]*>([^]*?)<\/title>/i);
    const title = ogTitle || twitterTitle || titleTag;

    const ogDesc = metaContent(html, "og:description");
    const twitterDesc = metaContent(html, "twitter:description");
    const metaDesc = metaContent(html, "description");
    const description =
      ogDesc || twitterDesc || metaDesc || firstParagraph(html);

    const ogSite = metaContent(html, "og:site_name");
    const siteName = ogSite || parsed.hostname;

    // Sanity check: if we got nothing structural, treat the page as
    // unparseable. Reflexive 200-with-empty-body responses fall here.
    if (!title && !description) return null;

    return { title, description, siteName, contentType };
  } catch {
    return null;
  }
}
