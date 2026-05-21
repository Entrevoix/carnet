/**
 * Carnet design system — "Ink & Mist".
 *
 * One bold indigo accent against warm off-white paper (light) and cool
 * near-black ink (dark). Material 3 baseline with the palette tokens
 * overridden so every Paper component (Button, Card, FAB, TextInput,
 * Banner, Dialog) pulls a coherent color without per-screen styling.
 *
 * Read DESIGN.md at the repo root for the rationale and the full token
 * map. This file is the runtime source of truth — if you change a value
 * here, update DESIGN.md to match.
 */

import { MD3LightTheme, MD3DarkTheme, type MD3Theme } from "react-native-paper";

// Brand accent — indigo. Single source of "color" in the app; everything
// else is paper/ink/cool-gray neutrals. Slightly lighter in dark mode so
// it doesn't punch through the surface.
const PRIMARY_LIGHT = "#5E63FF";
const PRIMARY_DARK = "#8A8FFF";

// Paper white (light) keeps a hint of warmth without being brown.
// Ink near-black (dark) is cool-tinted so the indigo accent stays readable.
const PAPER = "#FAFAF7";
const INK = "#0F1115";

export const inkAndMistLight: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: PRIMARY_LIGHT,
    onPrimary: "#FFFFFF",
    primaryContainer: "#E7E8FF",
    onPrimaryContainer: "#11132E",

    secondary: "#54595F",
    onSecondary: "#FFFFFF",
    secondaryContainer: "#E6E8EC",
    onSecondaryContainer: "#1A1C1E",

    tertiary: PRIMARY_LIGHT,
    onTertiary: "#FFFFFF",

    background: PAPER,
    onBackground: INK,
    surface: "#FFFFFF",
    onSurface: INK,
    surfaceVariant: "#EEF0F2",
    onSurfaceVariant: "#54595F",

    outline: "#D1D5DB",
    outlineVariant: "#E6E8EC",

    error: "#DC2626",
    onError: "#FFFFFF",
    errorContainer: "#FEE2E2",
    onErrorContainer: "#7F1D1D",

    elevation: {
      ...MD3LightTheme.colors.elevation,
      level0: "transparent",
      level1: "#FFFFFF",
      level2: "#FBFBFA",
      level3: "#F6F7F8",
      level4: "#F1F3F5",
      level5: "#ECEEF1",
    },

    inverseSurface: INK,
    inverseOnSurface: PAPER,
    inversePrimary: PRIMARY_DARK,

    scrim: "rgba(15, 17, 21, 0.5)",
    backdrop: "rgba(15, 17, 21, 0.4)",
  },
};

export const inkAndMistDark: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: PRIMARY_DARK,
    onPrimary: "#11132E",
    primaryContainer: "#2A2F8A",
    onPrimaryContainer: "#E7E8FF",

    secondary: "#9CA3AF",
    onSecondary: "#11132E",
    secondaryContainer: "#23272F",
    onSecondaryContainer: "#E7E9EC",

    tertiary: PRIMARY_DARK,
    onTertiary: "#11132E",

    background: INK,
    onBackground: "#E7E9EC",
    surface: "#171A21",
    onSurface: "#E7E9EC",
    surfaceVariant: "#23272F",
    onSurfaceVariant: "#9CA3AF",

    outline: "#374151",
    outlineVariant: "#23272F",

    error: "#F87171",
    onError: "#11132E",
    errorContainer: "#7F1D1D",
    onErrorContainer: "#FEE2E2",

    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level0: "transparent",
      level1: "#171A21",
      level2: "#1B1F27",
      level3: "#1F242D",
      level4: "#232830",
      level5: "#272D36",
    },

    inverseSurface: PAPER,
    inverseOnSurface: INK,
    inversePrimary: PRIMARY_LIGHT,

    scrim: "rgba(0, 0, 0, 0.6)",
    backdrop: "rgba(0, 0, 0, 0.5)",
  },
};
