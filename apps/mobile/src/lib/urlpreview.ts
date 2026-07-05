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

/** Extract the raw host (userinfo and port stripped) from a URL string
 * WITHOUT relying on `URL.hostname`.
 *
 * React Native's built-in `URL` (no `react-native-url-polyfill` installed)
 * does zero canonicalization: `hostname` returns the raw substring, and for
 * bracketed IPv6 literals it mangles `[::1]` down to `[`. The native fetch
 * layer (OkHttp / NSURLSession), however, DOES canonicalize before it
 * connects — so a deny-list keyed off `URL.hostname` sees a different host
 * than the one the socket actually dials. We parse the authority by hand so
 * the SSRF check operates on the same host the native layer will resolve,
 * and so the behavior is identical on-device and under the Node test URL. */
function extractHost(rawUrl: string): string | null {
  // WHATWG URL parsing strips ASCII tab / newline / carriage-return from the
  // URL *before* parsing, and the native fetch layer (OkHttp / NSURLSession)
  // does the same before it dials — so we must strip them first, or a byte
  // injected into the host (`http://12\t7.0.0.1/`) is seen here as the literal
  // `12<TAB>7.0.0.1` (which fails IP parsing) while the socket resolves the
  // stripped `127.0.0.1` and connects to loopback anyway.
  const cleaned = rawUrl.replace(/[\t\n\r]/g, "");
  const schemeMatch = cleaned.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (!schemeMatch) return null;
  const rest = cleaned.slice(schemeMatch[0].length);
  // Authority ends at the first path / query / fragment delimiter. For special
  // (http/https) schemes WHATWG treats a backslash the same as a forward slash
  // when locating the authority boundary, so `\` also terminates the authority:
  // `http://127.0.0.1\@evil.com/` dials 127.0.0.1, not evil.com. The scan stops
  // at the FIRST such delimiter, so a legitimate `\` later in the path or query
  // is never reached and stays untouched.
  const authEnd = rest.search(/[/\\?#]/);
  let authority = authEnd === -1 ? rest : rest.slice(0, authEnd);
  // Drop any userinfo (`user:pass@`).
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) {
    // Bracketed IPv6 literal — return the inner address, no brackets.
    const close = authority.indexOf("]");
    if (close === -1) return null;
    return authority.slice(1, close).toLowerCase();
  }
  // Strip a `:port` suffix (IPv6 without brackets is not a valid URL host).
  const colon = authority.indexOf(":");
  if (colon !== -1) authority = authority.slice(0, colon);
  return authority.toLowerCase();
}

/** Parse a single IPv4 component in decimal, hex (`0x`-prefixed), or octal
 * (leading `0`) form — the encodings `inet_aton`/browsers/curl accept.
 * Returns the numeric value, or null when the component is not a pure number
 * in one of those bases (i.e. it's a real DNS label like `example`). */
function parseIpv4Part(s: string): number | null {
  if (s.length === 0) return null;
  let radix: number;
  let digits: string;
  if (/^0x/i.test(s)) {
    radix = 16;
    digits = s.slice(2);
    if (!/^[0-9a-f]+$/i.test(digits)) return null;
  } else if (s[0] === "0" && s.length > 1) {
    radix = 8;
    digits = s.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else {
    radix = 10;
    digits = s;
    if (!/^[0-9]+$/.test(digits)) return null;
  }
  const n = parseInt(digits, radix);
  return Number.isFinite(n) ? n : null;
}

/** Render a 32-bit integer as dotted-decimal IPv4. */
function intToDotted(value: number): string {
  const b0 = Math.floor(value / 16777216) % 256;
  const b1 = Math.floor(value / 65536) % 256;
  const b2 = Math.floor(value / 256) % 256;
  const b3 = value % 256;
  return `${b0}.${b1}.${b2}.${b3}`;
}

/** Canonicalize a host to dotted-decimal IPv4 if — and only if — it parses as
 * an IPv4 address in ANY encoding (dotted-decimal, single decimal integer,
 * hex, octal, or a short/partial form like `127.1`). Returns null for real
 * hostnames so they fall through to normal DNS resolution.
 *
 * Follows the `inet_aton` "last part absorbs the remaining bytes" rule:
 * `127.1` → `127.0.0.1`, `2130706433` → `127.0.0.1`. */
function canonicalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  const count = nums.length;
  let value = 0;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    // The last component absorbs all bytes not claimed by earlier ones.
    const bytes = isLast ? 4 - (count - 1) : 1;
    const max = Math.pow(256, bytes) - 1;
    if (nums[i] < 0 || nums[i] > max) return null;
    value += isLast ? nums[i] : nums[i] * Math.pow(256, 3 - i);
  }
  if (value < 0 || value > 0xffffffff) return null;
  return intToDotted(value);
}

/** Expand an IPv6 literal to its 8 hextets, folding a trailing embedded IPv4
 * (`::ffff:127.0.0.1`) into two hextets first. Returns null if it does not
 * parse as IPv6. Lenient by design — it only feeds the loopback/link-local
 * block check, where over-recognizing never loosens the guard. */
function expandIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.length === 0) return null;
  // Fold a trailing dotted-quad (`::ffff:127.0.0.1`) into two hextets.
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon === -1) return null;
    const octs = s.slice(lastColon + 1).split(".");
    if (octs.length !== 4) return null;
    const v = octs.map((o) => (/^[0-9]+$/.test(o) ? parseInt(o, 10) : -1));
    if (v.some((x) => x < 0 || x > 255)) return null;
    const hi = (v[0] << 8) | v[1];
    const lo = (v[2] << 8) | v[3];
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseSeg = (seg: string): number[] | null => {
    if (seg === "") return [];
    const out: number[] = [];
    for (const h of seg.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const all = parseSeg(halves[0]);
    return all && all.length === 8 ? all : null;
  }
  const head = parseSeg(halves[0]);
  const tail = parseSeg(halves[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/** True when a canonical dotted-decimal IPv4 falls in a blocked range:
 * `0.0.0.0/8` (this-host), `127.0.0.0/8` (loopback), or `169.254.0.0/16`
 * (link-local, which contains the `169.254.169.254` cloud-metadata endpoint).
 * RFC1918 private ranges (`10.*`, `172.16-31.*`, `192.168.*`) are deliberately
 * NOT here — see {@link isBlockedHost}. */
function isBlockedIPv4(dotted: string): boolean {
  const [a, b] = dotted.split(".").map(Number);
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** True when the expanded IPv6 address is a blocked loopback / mapped form. */
function isBlockedIPv6(hextets: number[]): boolean {
  // ::1 loopback.
  if (hextets.slice(0, 7).every((x) => x === 0) && hextets[7] === 1) return true;
  // :: unspecified — equivalent to 0.0.0.0.
  if (hextets.every((x) => x === 0)) return true;
  // IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`): the low
  // 32 bits carry an IPv4 address we re-run through the v4 range check.
  const first5Zero = hextets.slice(0, 5).every((x) => x === 0);
  if (first5Zero && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const value = hextets[6] * 65536 + hextets[7];
    return isBlockedIPv4(intToDotted(value));
  }
  return false;
}

/** SSRF guard: hosts that should NEVER be reached by a URL preview
 * fetch, even though the device's network position could otherwise
 * reach them.
 *
 *   - loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0/8`) — pointing
 *     a preview at the user's own device serves no legitimate purpose
 *     and exposes any locally-bound dev servers.
 *   - link-local cloud metadata (`169.254.0.0/16`, incl. `169.254.169.254`) —
 *     the AWS/GCP/Azure instance metadata service. High-value SSRF target.
 *
 * The check normalizes non-canonical IP encodings BEFORE comparing, so
 * decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), short
 * (`127.1`), and IPv4-mapped-IPv6 (`::ffff:127.0.0.1`) forms of a blocked
 * address are all caught — RN's `URL` does not canonicalize these but the
 * native fetch layer resolves them to the real loopback/link-local address.
 * Membership is tested by numeric range, not string literal.
 *
 * General RFC1918 private ranges (`10.*`, `172.16-31.*`, `192.168.*`)
 * are deliberately NOT blocked: the user may legitimately bookmark
 * self-hosted services on their LAN. The user's threat model here is
 * "I am sharing my own URLs", not "an attacker is pivoting through
 * my shares". A blocked-hosts list lives at the boundary; a wider
 * deny-list belongs in a future explicit setting.
 *
 * `rawHost` must be an already-extracted host (see {@link extractHost}),
 * not a full URL — no scheme, no port, no brackets required. */
function isBlockedHost(rawHost: string): boolean {
  // Strip a trailing root dot (`127.0.0.1.` resolves the same as `127.0.0.1`).
  const h = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (h === "") return false;
  const unbracketed = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (unbracketed === "localhost") return true;
  if (unbracketed.includes(":")) {
    const hextets = expandIPv6(unbracketed);
    return hextets ? isBlockedIPv6(hextets) : false;
  }
  const dotted = canonicalizeIPv4(unbracketed);
  return dotted ? isBlockedIPv4(dotted) : false;
}

/** Maximum redirect hops to follow before giving up. Guards against redirect
 * loops and a malicious server dragging out the fetch with an endless 3xx
 * chain. */
const MAX_REDIRECTS = 5;

/** HTTP status codes that carry a `Location` header we follow manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Internal: follow redirects MANUALLY (`redirect: "manual"`), re-running the
 * SSRF host guard on every hop.
 *
 * `redirect: "follow"` would let a public page 3xx-redirect to `localhost`,
 * `169.254.169.254`, or a LAN host and the browser/RN engine would silently
 * fire the follow-up GET before we could inspect the target — the exact SSRF
 * hole isBlockedHost is meant to close. Following by hand lets us validate the
 * scheme AND host of each redirect target before issuing the next request. */
async function followWithRedirects(
  startUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = startUrl;
  let redirects = 0;
  for (;;) {
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    // A 3xx with no Location is malformed — hand it back so the caller's
    // `!response.ok` path collapses it to null rather than looping.
    const location = response.headers.get("location");
    if (!location) return response;

    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      throw new Error(`URL preview: too many redirects (>${MAX_REDIRECTS})`);
    }

    let next: URL;
    try {
      // Resolve relative Location headers against the current URL.
      next = new URL(location, currentUrl);
    } catch {
      throw new Error("URL preview: invalid redirect Location");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error("URL preview: redirect to non-http(s) scheme blocked");
    }
    // SSRF guard on EVERY hop — see isBlockedHost JSDoc for the threat model.
    // Extract the host from the raw URL string rather than `next.hostname`:
    // RN's URL leaves non-canonical IP encodings and bracketed IPv6 unparsed.
    if (isBlockedHost(extractHost(next.toString()) ?? next.hostname)) {
      throw new Error("URL preview: redirect to blocked host");
    }
    currentUrl = next.toString();
  }
}

/** Internal: do the fetch with a HARD timeout, following redirects manually.
 * Rejects on timeout or a blocked redirect target; propagates other fetch
 * errors (the sole caller maps any throw to null).
 *
 * Races the whole redirect chain against an independent reject-timer because
 * RN's fetch does not reject when AbortController.abort() fires during a stuck
 * connect to an unreachable host — a bare AbortController would hang forever.
 * The timeout budget covers the ENTIRE chain, not each hop. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* best-effort cancel */
      }
      reject(new Error(`URL preview timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      followWithRedirects(url, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  // SSRF guard — see isBlockedHost JSDoc for the threat model. Extract the
  // host from the raw URL rather than `parsed.hostname`: RN's URL does not
  // canonicalize numeric/hex/octal IP encodings or bracketed IPv6 literals.
  if (isBlockedHost(extractHost(url) ?? parsed.hostname)) {
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
