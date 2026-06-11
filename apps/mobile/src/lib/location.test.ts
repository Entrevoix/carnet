import { beforeEach, describe, expect, it, vi } from "vitest";

// expo-location is aliased to a vitest stub (vitest.config.ts); grab its vi.fn()s
// to drive permission/position/geocode outcomes per test.
import {
  getForegroundPermissionsAsync,
  requestForegroundPermissionsAsync,
  getCurrentPositionAsync,
  reverseGeocodeAsync,
} from "expo-location";
import { describeCoords, formatCoords, getCurrentCoords, parseCoords } from "./location";

beforeEach(() => vi.clearAllMocks());

// tsc resolves expo-location to its real (strict) types, so build the partial
// mock payloads through these casts rather than filling every field.
type PermResult = Awaited<ReturnType<typeof getForegroundPermissionsAsync>>;
type PosResult = Awaited<ReturnType<typeof getCurrentPositionAsync>>;
type GeoResult = Awaited<ReturnType<typeof reverseGeocodeAsync>>;
const perm = (granted: boolean, canAskAgain: boolean): PermResult =>
  ({ granted, canAskAgain, status: granted ? "granted" : "denied" }) as unknown as PermResult;
const pos = (latitude: number, longitude: number): PosResult =>
  ({ coords: { latitude, longitude } }) as unknown as PosResult;
const geo = (entries: Array<Record<string, string>>): GeoResult => entries as unknown as GeoResult;

// ── formatCoords ──────────────────────────────────────────────────────────────

describe("formatCoords", () => {
  it("formats with fixed 5-dp precision", () => {
    expect(formatCoords({ lat: 38.9072, lon: -77.0369 })).toBe("38.90720,-77.03690");
  });

  it("rounds to 5 dp", () => {
    expect(formatCoords({ lat: 1.123456789, lon: -2.987654321 })).toBe("1.12346,-2.98765");
  });
});

// ── parseCoords ───────────────────────────────────────────────────────────────

describe("parseCoords", () => {
  it("round-trips a formatted string", () => {
    expect(parseCoords("38.90720,-77.03690")).toEqual({ lat: 38.9072, lon: -77.0369 });
  });

  it("tolerates surrounding and inner whitespace", () => {
    expect(parseCoords("  38.9 , -77.0 ")).toEqual({ lat: 38.9, lon: -77 });
  });

  it("returns null for malformed input", () => {
    expect(parseCoords("not coords")).toBeNull();
    expect(parseCoords("38.9")).toBeNull();
    expect(parseCoords("38.9,-77,12")).toBeNull();
    expect(parseCoords("")).toBeNull();
  });

  it("returns null for out-of-range values", () => {
    expect(parseCoords("91,0")).toBeNull();
    expect(parseCoords("0,181")).toBeNull();
    expect(parseCoords("-91,0")).toBeNull();
  });

  it("accepts boundary values", () => {
    expect(parseCoords("90,180")).toEqual({ lat: 90, lon: 180 });
    expect(parseCoords("-90,-180")).toEqual({ lat: -90, lon: -180 });
  });

  it("round-trips formatCoords output", () => {
    const c = { lat: 51.50735, lon: -0.12776 };
    expect(parseCoords(formatCoords(c))).toEqual(c);
  });
});

// ── getCurrentCoords ──────────────────────────────────────────────────────────

describe("getCurrentCoords", () => {
  it("returns coords when permission is already granted", async () => {
    vi.mocked(getForegroundPermissionsAsync).mockResolvedValue(perm(true, true));
    vi.mocked(getCurrentPositionAsync).mockResolvedValue(pos(1.5, 2.5));
    expect(await getCurrentCoords()).toEqual({ lat: 1.5, lon: 2.5 });
  });

  it("requests permission when not yet granted but can ask", async () => {
    vi.mocked(getForegroundPermissionsAsync).mockResolvedValue(perm(false, true));
    vi.mocked(requestForegroundPermissionsAsync).mockResolvedValue(perm(true, true));
    vi.mocked(getCurrentPositionAsync).mockResolvedValue(pos(3, 4));
    expect(await getCurrentCoords()).toEqual({ lat: 3, lon: 4 });
    expect(requestForegroundPermissionsAsync).toHaveBeenCalledOnce();
  });

  it("returns null when denied and cannot ask again (no prompt)", async () => {
    vi.mocked(getForegroundPermissionsAsync).mockResolvedValue(perm(false, false));
    expect(await getCurrentCoords()).toBeNull();
    expect(requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("returns null when the position fix throws", async () => {
    vi.mocked(getForegroundPermissionsAsync).mockResolvedValue(perm(true, true));
    vi.mocked(getCurrentPositionAsync).mockRejectedValue(new Error("no fix"));
    expect(await getCurrentCoords()).toBeNull();
  });
});

// ── describeCoords (display-only reverse geocode) ────────────────────────────

describe("describeCoords", () => {
  it("joins city + region into a short label", async () => {
    vi.mocked(reverseGeocodeAsync).mockResolvedValue(geo([{ city: "Washington", region: "DC" }]));
    expect(await describeCoords({ lat: 38.9, lon: -77 })).toBe("Washington, DC");
  });

  it("falls back to subregion when city is absent", async () => {
    vi.mocked(reverseGeocodeAsync).mockResolvedValue(
      geo([{ subregion: "Marin County", region: "CA" }]),
    );
    expect(await describeCoords({ lat: 38, lon: -122 })).toBe("Marin County, CA");
  });

  it("returns null when geocoding yields nothing", async () => {
    vi.mocked(reverseGeocodeAsync).mockResolvedValue(geo([]));
    expect(await describeCoords({ lat: 0, lon: 0 })).toBeNull();
  });

  it("returns null on geocode error", async () => {
    vi.mocked(reverseGeocodeAsync).mockRejectedValue(new Error("offline"));
    expect(await describeCoords({ lat: 0, lon: 0 })).toBeNull();
  });
});
