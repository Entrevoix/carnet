/**
 * Location capture for carnet. Coordinates are stored in note frontmatter as a
 * plain `lat,lon` string (Obsidian-friendly, no map embed, no place object) —
 * see the plan's "NOT Building". The format/parse helpers are pure; the
 * getCurrentCoords wrapper is the only native (expo-location) surface.
 */
import * as Location from "expo-location";

export interface Coords {
  lat: number;
  lon: number;
}

/** Fixed precision for the stored string — 5 dp ≈ ~1.1m, plenty for a capture. */
const PRECISION = 5;

/** Format coords as a compact `"38.90720,-77.03690"` string. */
export function formatCoords(coords: Coords): string {
  return `${coords.lat.toFixed(PRECISION)},${coords.lon.toFixed(PRECISION)}`;
}

/**
 * Parse a `lat,lon` string back to Coords, or null when malformed or out of
 * range. Tolerates surrounding/inner whitespace; rejects anything that isn't
 * two finite numbers within [-90,90] / [-180,180].
 */
export function parseCoords(value: string): Coords | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Request foreground location permission (only prompting when we still can) and
 * return the current coordinates. Returns null when permission is denied or the
 * fix fails — callers surface that as "couldn't get location", never a crash.
 */
export async function getCurrentCoords(): Promise<Coords | null> {
  const current = await Location.getForegroundPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) {
    granted = (await Location.requestForegroundPermissionsAsync()).granted;
  }
  if (!granted) return null;

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: position.coords.latitude, lon: position.coords.longitude };
  } catch {
    return null;
  }
}

/**
 * Best-effort, display-only reverse geocode of coords to a short place label
 * (e.g. "Washington, DC"). NOT persisted to disk — the note stores only
 * `lat,lon`. Returns null when geocoding is unavailable or yields nothing.
 */
export async function describeCoords(coords: Coords): Promise<string | null> {
  try {
    const [place] = await Location.reverseGeocodeAsync({
      latitude: coords.lat,
      longitude: coords.lon,
    });
    if (!place) return null;
    const parts = [place.city ?? place.subregion, place.region].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  } catch {
    return null;
  }
}
