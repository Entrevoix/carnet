/**
 * Carnet design system — "Stamped Paper".
 *
 * Warm paper neutrals with a single ink-teal accent and a stamp-red reserved
 * for destructive moments. Material 3 baseline with every palette token
 * overridden so all Paper components (Button, Card, FAB, TextInput, Banner,
 * Dialog) pull a coherent color without per-screen styling. Dark mode gets
 * elevation from lighter surfaces plus 1px borders, never drop shadows.
 *
 * Read DESIGN.md at the repo root for the rationale and the full token map.
 * This file is the runtime source of truth — if you change a value here,
 * update DESIGN.md to match.
 */

import {
  configureFonts,
  MD3DarkTheme,
  MD3LightTheme,
  useTheme,
  type MD3Theme,
} from "react-native-paper";

// ── Palette ──────────────────────────────────────────────────────────────────

// Light
const PAPER = "#F5F2EA"; // app background
const INK = "#22201C"; // primary text
const INK_SOFT = "#6B665C"; // secondary text
const ACCENT = "#2C6155"; // ink-teal, primary actions
const ACCENT_SOFT = "#DCE7E2"; // chip / badge background
const CARD = "#FFFFFF";
const LINE = "#E4DFD2"; // borders

// Dark
const PAPER_DARK = "#17181B";
const INK_ON_DARK = "#E9E6DD";
// Lifted from the brief's #8B887F: that lands at 4.48:1 on cardDark, a hair
// under WCAG AA (4.5:1) for secondary text. #949188 clears it with margin.
const INK_SOFT_ON_DARK = "#949188";
const ACCENT_BRIGHT = "#8FCABB"; // teal for text/icons on dark surfaces
const ACCENT_SOFT_DARK = "#1E3B34";
const CARD_DARK = "#212226";
const LINE_DARK = "#2E2F33";

// Destructive / reject. Same hue in both modes — the stamp does not shift.
const STAMP = "#B4472E";
// Stamp red used AS TEXT on dark surfaces fails contrast (2.9:1), so MD3's
// `error` slot — which Paper components use for error text (HelperText,
// error labels) — gets a brightened tone in dark mode. Fills, borders, and
// badges keep the true stamp via `carnet.stamp` / `errorContainer`.
const STAMP_TEXT_ON_DARK = "#E27D5F";

// ── Non-color tokens ─────────────────────────────────────────────────────────

/** Spacing scale (dp). Use these instead of magic padding/gap numbers. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner radii (dp). Cards 16, sheets/dialogs 20, chips & FABs pill. */
export const radius = {
  sm: 8,
  md: 12,
  card: 16,
  sheet: 20,
  pill: 9999,
} as const;

/** Minimum tap target (dp) for any interactive element. */
export const MIN_TAP_TARGET = 48;

/**
 * Carnet-specific tokens Paper's MD3 scheme has no slot for. Reach them via
 * `useCarnetTheme().carnet`.
 */
export interface CarnetTokens {
  /** Stamp red — destructive/reject fills and badge borders (both modes). */
  stamp: string;
  /** Solid teal fill for high-emphasis CTAs. On dark this stays the deep
   * accent (#2C6155) per the design brief, while `colors.primary` is the
   * brightened teal that text/icons need for contrast. */
  fill: string;
  /** Foreground for content sitting on `fill`. */
  onFill: string;
  spacing: typeof spacing;
  radius: typeof radius;
}

export type CarnetTheme = MD3Theme & { carnet: CarnetTokens };

/** `useTheme()` narrowed to the Carnet theme so `theme.carnet.*` type-checks. */
export function useCarnetTheme(): CarnetTheme {
  return useTheme<CarnetTheme>();
}

/**
 * Caret/selection props for native TextInputs. Android's default caret is
 * near-invisible on the dark ink surface, so every TextInput spreads these:
 * the caret and selection handles take the theme primary (dark mode's
 * brightened teal #8FCABB holds contrast on #17181B; light mode's deep teal
 * reads fine on paper), and the selection highlight is the same teal at ~40%
 * so selected text stays legible.
 */
export function caretProps(theme: MD3Theme | CarnetTheme): {
  cursorColor: string;
  selectionColor: string;
  selectionHandleColor: string;
} {
  return {
    cursorColor: theme.colors.primary,
    selectionColor: `${theme.colors.primary}66`,
    selectionHandleColor: theme.colors.primary,
  };
}

// ── Typography ───────────────────────────────────────────────────────────────
//
// Space Grotesk carries display/headline/title voice; Inter carries body and
// UI labels. Weight discipline: max two weights per screen — SG 600 for
// headings, Inter 400 body / 500 labels. Font files are bundled via
// @expo-google-fonts and loaded in App.tsx (render is gated on useFonts), so
// by the time any themed text draws, the families exist. fontWeight stays
// "normal": with bundled font files the weight is baked into the family and
// a numeric weight would trigger Android faux-bolding.

export const FONT_ASSETS = {
  display: "SpaceGrotesk_600SemiBold",
  body: "Inter_400Regular",
  label: "Inter_500Medium",
} as const;

type MD3FontVariant = keyof typeof MD3LightTheme.fonts;

function familyFor(variant: MD3FontVariant): string {
  if (variant.startsWith("body")) return FONT_ASSETS.body;
  if (variant.startsWith("label")) return FONT_ASSETS.label;
  // display*, headline*, title* — the "voice" tiers.
  if (variant === "titleSmall") return FONT_ASSETS.label; // list/appbar UI text
  return FONT_ASSETS.display;
}

const fontConfig = Object.fromEntries(
  (Object.keys(MD3LightTheme.fonts) as MD3FontVariant[])
    .filter((v) => v !== "default")
    .map((variant) => [
      variant,
      {
        ...MD3LightTheme.fonts[variant],
        fontFamily: familyFor(variant),
        fontWeight: "normal" as const,
      },
    ]),
);

const fonts = configureFonts({ config: fontConfig });

// ── Themes ───────────────────────────────────────────────────────────────────

export const carnetLight: CarnetTheme = {
  ...MD3LightTheme,
  fonts,
  colors: {
    ...MD3LightTheme.colors,
    primary: ACCENT,
    onPrimary: "#FFFFFF",
    primaryContainer: ACCENT_SOFT,
    onPrimaryContainer: "#1B3B33",

    secondary: INK_SOFT,
    onSecondary: "#FFFFFF",
    secondaryContainer: "#EAE6DA",
    onSecondaryContainer: INK,

    tertiary: ACCENT,
    onTertiary: "#FFFFFF",

    background: PAPER,
    onBackground: INK,
    surface: CARD,
    onSurface: INK,
    surfaceVariant: "#EDE9DE",
    onSurfaceVariant: INK_SOFT,

    outline: LINE,
    outlineVariant: "#EDE9DE",

    error: STAMP,
    onError: "#FFFFFF",
    errorContainer: "#F6DFD7",
    onErrorContainer: "#5A2317",

    elevation: {
      ...MD3LightTheme.colors.elevation,
      level0: "transparent",
      level1: CARD,
      level2: "#FBF9F3",
      level3: "#F8F5EC",
      level4: "#F4F1E6",
      level5: "#F1EDE0",
    },

    inverseSurface: INK,
    inverseOnSurface: PAPER,
    inversePrimary: ACCENT_BRIGHT,

    scrim: "rgba(34, 32, 28, 0.5)",
    backdrop: "rgba(34, 32, 28, 0.4)",
  },
  carnet: {
    stamp: STAMP,
    fill: ACCENT,
    onFill: "#FFFFFF",
    spacing,
    radius,
  },
};

export const carnetDark: CarnetTheme = {
  ...MD3DarkTheme,
  fonts,
  colors: {
    ...MD3DarkTheme.colors,
    // Brightened teal so text/icons/focus states hold contrast on ink.
    // Solid-fill CTAs that must stay deep teal use `carnet.fill` instead.
    primary: ACCENT_BRIGHT,
    onPrimary: "#14322B",
    primaryContainer: ACCENT_SOFT_DARK,
    onPrimaryContainer: ACCENT_SOFT,

    secondary: INK_SOFT_ON_DARK,
    onSecondary: PAPER_DARK,
    secondaryContainer: "#2A2B30",
    onSecondaryContainer: INK_ON_DARK,

    tertiary: ACCENT_BRIGHT,
    onTertiary: "#14322B",

    background: PAPER_DARK,
    onBackground: INK_ON_DARK,
    surface: CARD_DARK,
    onSurface: INK_ON_DARK,
    surfaceVariant: "#26282D",
    onSurfaceVariant: INK_SOFT_ON_DARK,

    outline: LINE_DARK,
    outlineVariant: "#26282D",

    error: STAMP_TEXT_ON_DARK,
    onError: "#22201C",
    errorContainer: "#46231A",
    onErrorContainer: "#F3CDC2",

    // Dark elevation = lighter surface tones (paired at the component level
    // with a 1px `outline` border), never shadow.
    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level0: "transparent",
      level1: CARD_DARK,
      level2: "#25262B",
      level3: "#292A2F",
      level4: "#2C2D33",
      level5: "#303137",
    },

    inverseSurface: INK_ON_DARK,
    inverseOnSurface: INK,
    inversePrimary: ACCENT,

    scrim: "rgba(0, 0, 0, 0.6)",
    backdrop: "rgba(0, 0, 0, 0.5)",
  },
  carnet: {
    stamp: STAMP,
    fill: ACCENT,
    onFill: INK_ON_DARK,
    spacing,
    radius,
  },
};
