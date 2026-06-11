// Vitest-only stub for expo-location. The real module pulls in
// expo-modules-core -> react-native (Flow), which Rollup's parser can't handle,
// so it's aliased here (see vitest.config.ts). Exports vi.fn()s so tests can
// drive permission/position/geocode outcomes via mockResolvedValue.
import { vi } from "vitest";

export const Accuracy = {
  Lowest: 1,
  Low: 2,
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
} as const;

export const getForegroundPermissionsAsync = vi.fn(async () => ({
  granted: true,
  canAskAgain: true,
  status: "granted",
}));

export const requestForegroundPermissionsAsync = vi.fn(async () => ({
  granted: true,
  canAskAgain: true,
  status: "granted",
}));

export const getCurrentPositionAsync = vi.fn(async () => ({
  coords: { latitude: 0, longitude: 0 },
}));

export const reverseGeocodeAsync = vi.fn(async () => [] as Array<Record<string, string>>);
