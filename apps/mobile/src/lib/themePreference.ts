/**
 * Manual light/dark override for the app theme.
 *
 * Kept in its own AsyncStorage key (not the settings blob) because App.tsx
 * needs it at cold start, before the heavier getSettings() path (SecureStore
 * reads, legacy purge) has any reason to run. "system" mirrors the OS
 * setting via useColorScheme(); "light"/"dark" pin the theme regardless.
 */

import { createContext, useContext } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const THEME_PREFERENCE_KEY = "carnet:theme_preference:v1";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];

function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

/** Read the stored preference; unknown/corrupt values fall back to "system". */
export async function getThemePreference(): Promise<ThemePreference> {
  try {
    const raw = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    // A failed read must never block app start — fall back to system.
    return "system";
  }
}

export async function setThemePreference(
  preference: ThemePreference,
): Promise<void> {
  await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
}

export interface ThemePreferenceContextValue {
  preference: ThemePreference;
  /** Persists and applies the preference app-wide (provided by App.tsx). */
  setPreference: (preference: ThemePreference) => void;
}

/** Provided by App.tsx; consumed by the Settings appearance toggle. */
export const ThemePreferenceContext =
  createContext<ThemePreferenceContextValue>({
    preference: "system",
    setPreference: () => {
      // no-op default — real setter injected by the App provider
    },
  });

export function useThemePreference(): ThemePreferenceContextValue {
  return useContext(ThemePreferenceContext);
}
