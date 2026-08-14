/**
 * Resolve a pasted Google Maps URL to a named place + coordinates.
 *
 * Two input shapes:
 *   - Long form (`https://www.google.com/maps/place/Rud-Alpe/@47.2,10.1,17z/…`)
 *     already carries the coordinates in the URL — parsed locally, no network.
 *   - Short form (`https://maps.app.goo.gl/xyz`) carries nothing — the redirect
 *     chain is followed to recover the long-form URL, then parsed the same way.
 *
 * The redirect follow reuses urlpreview.ts's SSRF-guarded primitives rather
 * than reimplementing them: a link resolver is exactly as reachable an SSRF
 * vector as the URL-preview feature, and two copies of that guard would drift.
 *
 * Never throws — every failure collapses to a ResolvePlaceOutcome.
 */

import { formatCoords, parseCoords, type ResolvePlaceOutcome } from "./location";
import { extractHost, fetchWithTimeout, isBlockedHost } from "./urlpreview";

/** Coordinate carriers that name ONE place explicitly — safe on any Maps URL
 * shape, because the user (or Google) put those exact coordinates there.
 * `!3d!4d` is the pin the place actually sits on. */
const EXPLICIT_COORD_PATTERNS: readonly RegExp[] = [
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // .../data=…!3d47.2011!4d10.1166
  /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, // ...?q=47.2011,10.1166
  /[?&]query=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, // ...?api=1&query=47.2,10.1
];

/** The map VIEWPORT center — only meaningful when the URL is about a single
 * location. On a directions URL it is the midpoint between the endpoints
 * (a Paris→Lyon link centers on farmland near Moulins), so it is gated to the
 * shapes below rather than used as a universal fallback. */
const VIEWPORT_COORD_RE = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

/** URL shapes where `@lat,lon` describes the place the link is about: a place
 * page, a search, or a bare shared map view. */
const VIEWPORT_OK_PATH_RE = /\/maps\/(?:place\/|search\/|@)/;

/** Directions links. Their waypoints live in `!1d`/`!2d` pairs this parser
 * does not read, so without an explicit reject they would fall through to the
 * viewport center and silently save coordinates for neither endpoint. */
const DIRECTIONS_PATH_RE = /\/maps\/dir\//;

/** `/maps/place/<name>/…` — the human label Google puts in the path. */
const PLACE_NAME_RE = /\/place\/([^/?#]+)/;

/** Two-label public suffixes Google serves Maps from. Enumerated rather than
 * pattern-matched: any regex permissive enough to accept `co.uk` also accepts
 * an attacker's `evil.io`, which would make `google.evil.io` a valid Maps host
 * and hand the parser (and the redirect gate) to whoever registers it. */
const GOOGLE_MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "co.jp",
  "co.in",
  "co.kr",
  "co.nz",
  "co.th",
  "co.za",
  "com.au",
  "com.br",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
]);

/** Hosts whose URLs we will parse as Maps links. Anything else is rejected
 * before a coordinate parse, so a hostile `https://evil.com/@1,2` can't
 * masquerade as a place.
 *
 * The suffix is matched EXACTLY — either one all-letter label (`com`, `de`,
 * `fr`) or a listed two-label ccTLD. A dotted wildcard here would be a prefix
 * match, not a TLD match: `google.evil.com` and `maps.google.attacker.com`
 * would both pass, defeating the whole check. This same predicate gates the
 * short-link redirect target, so a loose match is an SSRF-adjacent hole too. */
function isGoogleMapsHost(host: string): boolean {
  if (host === "goo.gl" || host === "maps.app.goo.gl") return true;
  const match = /^(?:www\.|maps\.)?google\.([a-z.]+)$/.exec(host);
  if (!match) return false;
  const suffix = match[1];
  return /^[a-z]{2,}$/.test(suffix) || GOOGLE_MULTI_LABEL_SUFFIXES.has(suffix);
}

/** Short-link hosts that carry no coordinates and must be resolved over the
 * network before parsing. */
function isShortLinkHost(host: string): boolean {
  return host === "maps.app.goo.gl" || host === "goo.gl";
}

/** Decode a `+`-separated, percent-encoded path segment into a display name.
 * Returns null when the segment is not valid percent-encoding. */
function decodePlaceName(segment: string): string | null {
  try {
    return decodeURIComponent(segment.replace(/\+/g, " ")).trim() || null;
  } catch {
    return null;
  }
}

/** Pull coordinates out of an already-resolved long-form Maps URL. Range
 * validation goes through parseCoords, so an out-of-range `@999,999` is
 * rejected here exactly as it would be from the manual-entry field. */
function parseLongFormUrl(url: string): ResolvePlaceOutcome {
  // A directions link describes a route, not a place — fail cleanly rather
  // than guessing a coordinate that belongs to neither endpoint.
  if (DIRECTIONS_PATH_RE.test(url)) return { kind: "invalidLink" };

  const patterns = VIEWPORT_OK_PATH_RE.test(url)
    ? [...EXPLICIT_COORD_PATTERNS, VIEWPORT_COORD_RE]
    : EXPLICIT_COORD_PATTERNS;

  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (!match) continue;
    const coords = parseCoords(`${match[1]},${match[2]}`);
    if (!coords) continue;
    const nameMatch = PLACE_NAME_RE.exec(url);
    const decoded = nameMatch ? decodePlaceName(nameMatch[1]) : null;
    return { kind: "ok", place: decoded ?? formatCoords(coords), coords };
  }
  return { kind: "invalidLink" };
}

/**
 * Resolve a pasted Google Maps URL to a place. Short links cost one
 * SSRF-guarded network round-trip; long-form links are parsed offline.
 */
export async function resolveMapsLink(url: string): Promise<ResolvePlaceOutcome> {
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) return { kind: "invalidLink" };

  const host = extractHost(target);
  if (host === null || !isGoogleMapsHost(host)) return { kind: "invalidLink" };
  // Defense in depth: a Maps host should never resolve to a blocked address,
  // but the guard runs on the entry URL as well as every redirect hop.
  if (isBlockedHost(host)) return { kind: "error", message: "Could not resolve the Maps link." };

  if (isShortLinkHost(host)) {
    try {
      const { response, finalUrl } = await fetchWithTimeout(target);
      // An expired or revoked short link 404s. Without this the unresolved
      // short URL would be parsed and reported as "not a Maps link", pointing
      // the user at their input instead of at the dead link.
      if (!response.ok) return { kind: "error", message: "Could not resolve the Maps link." };
      target = finalUrl;
    } catch {
      // Timeout, network failure, or a redirect into a blocked host.
      return { kind: "error", message: "Could not resolve the Maps link." };
    }
    const finalHost = extractHost(target);
    if (finalHost === null || !isGoogleMapsHost(finalHost)) return { kind: "invalidLink" };
  }

  return parseLongFormUrl(target);
}
