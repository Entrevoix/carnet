# Design System — Carnet ("Stamped Paper")

The visual identity for carnet, the mobile-first capture tool for Obsidian. This file is the source of truth for color, typography, surfaces, spacing, motion, and iconography. **Read this before making any visual or UI change.** The runtime tokens live in `apps/mobile/src/lib/theme.ts`; if you change a value there, mirror it here.

## Product context
- **What this is:** mobile-first knowledge capture writing plain markdown into a Syncthing-watched Obsidian vault, with self-hostable LLM enrichment via OmniRoute.
- **Who it's for:** Obsidian users (Android first) who want fast intake without opening the full vault editor on their phone.
- **Memorable thing:** warm paper surfaces, one ink-teal accent, and the **stamp** — a dashed-border, slightly rotated pill used for tags, sync badges, and category labels. Like a field notebook that gets stamped as things are filed.

## Aesthetic direction
- **Direction:** flat, modern Material 3 on warm paper neutrals. One ink-teal accent; a stamp-red reserved for destructive/reject moments.
- **Decoration level:** minimal, with exactly one recurring motif — the stamp. No other decorative devices; typography and color do the rest. No gradients, no textures, no drop shadows for decoration.
- **Mood:** confident utility with a hint of stationery character. A serious tool that still feels like paper.
- **Modes:** capture surfaces are distraction-free and full-bleed; browse/organize surfaces are structured cards with metadata. The user should always know which mode they're in.

## Color

### Accent
- **`primary` (light):** `#2C6155` — ink-teal. Primary actions, FAB, active states, links, focus rings.
- **`primary` (dark):** `#8FCABB` — brightened teal so text/icons/focus states hold contrast on the dark ink surface.
- **`carnet.fill` (both modes):** `#2C6155` — solid-fill CTA color. On dark, Paper's `primary` is the bright teal (correct for text/icons per M3), so components that must keep the *deep* teal fill reach for `carnet.fill` instead.

The accent is **rare and meaningful.** Most of the screen is paper/ink neutrals. Teal arrives only on actions and active state.

### Surfaces
| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#F5F2EA` | `#17181B` | App surface — warm paper (light), near-black ink (dark). |
| `surface` | `#FFFFFF` | `#212226` | Cards, sheets, dialogs, modals. |
| `surfaceVariant` | `#EDE9DE` | `#26282D` | Code blocks, muted containers, banner backgrounds. |
| `outline` | `#E4DFD2` | `#2E2F33` | Borders, dividers. **Dark-mode elevation = lighter surface + 1px `outline` border, never shadow.** |
| `outlineVariant` | `#EDE9DE` | `#26282D` | Lighter dividers (inside groups). |

### Text
| Token | Light | Dark |
|---|---|---|
| `onBackground` / `onSurface` | `#22201C` (ink) | `#E9E6DD` |
| `onSurfaceVariant` (secondary text) | `#6B665C` (inkSoft) | `#949188` (lifted from the brief's `#8B887F`, which sat at 4.48:1 — just under WCAG AA) |

### Chips / badges
| Token | Light | Dark | Use |
|---|---|---|---|
| `primaryContainer` | `#DCE7E2` | `#1E3B34` | Stamp/chip/badge background tint. |
| `onPrimaryContainer` | `#1B3B33` | `#DCE7E2` | Text on the above. |

### Semantic
| Token | Light | Dark | When |
|---|---|---|---|
| `carnet.stamp` | `#B4472E` | `#B4472E` | Destructive/reject **fills, borders, badges** — the stamp-red does not shift between modes. |
| `error` | `#B4472E` | `#E27D5F` | What Paper uses for error **text** (HelperText etc.). Raw stamp-red is 2.9:1 on dark surfaces, so the dark text tone is brightened; the stamp itself stays fixed via `carnet.stamp`. |
| `errorContainer` | `#F6DFD7` | `#46231A` | Filled error backgrounds; paired text rides `onErrorContainer` (`#5A2317` / `#F3CDC2`). |

No `success` / `warning` / `info` tokens. The intake-only flow has no positive-confirmation moments that justify green. If a future flow needs success, add it here first.

### Rules
- **No second accent hue.** Teal acts; stamp-red rejects; everything else is paper/ink.
- **No gradients** anywhere — buttons, headers, splash, anything.
- **No colored icons** in the UI body. Icons inherit `onSurface`/`onSurfaceVariant`, or `primary` when active.
- **Every screen, sheet, and dialog ships light *and* dark.** Never branch on `isSystemInDarkTheme`-style checks in components — consume `useTheme()`/`useCarnetTheme()` and the right values arrive.
- **The splash + Android adaptive-icon background** is the teal (`#2C6155`).
- **Every native `TextInput` spreads `caretProps(theme)`** (`apps/mobile/src/lib/theme.ts`) so the caret/selection use `colors.primary` — Android's default caret is near-invisible on the dark ink surface.

## The stamp (signature element)
Pill shape · **dashed 1px border** in `primary` (or `carnet.stamp` for destructive states) · background `primaryContainer` · slight `-1deg` rotation · label in Inter 500. Used for: note tags, sync-status badges, category/mode labels. It is the **only** decorative motif — do not introduce competing devices. (Android caveat: dashed borders need a `borderRadius`-compatible path on some RN versions; if a device renders artifacts, drop to solid border, keep the rotation.)

## Typography
Two bundled families (via `@expo-google-fonts`, loaded in `App.tsx`; render is gated on `useFonts`):
- **Space Grotesk 600** — display, headlines, titles (`display*`, `headline*`, `titleLarge/Medium`).
- **Inter 400** — body text (`body*`); **Inter 500** — UI labels, buttons, `titleSmall` (`label*`).

Max **two weights per screen**. Note/markdown *content* renders in Inter as well — captures are short, skimmed notes; no serif reading face (decided 2026-07-08). Monospace stays for code blocks and file paths. Use `<Text variant="...">` over inline `fontSize` — the Paper M3 type scale is the contract.

## Spacing
- **Base unit:** 4dp. Runtime scale: `theme.carnet.spacing` — `xs=4, sm=8, md=12, lg=16, xl=24, xxl=32, xxxl=48`. Use the tokens, not magic numbers.
- **Density:** comfortable; capture screens err toward air.

## Layout
- **Approach:** grid-disciplined, single column, mobile-portrait.
- **Border radius:** `theme.carnet.radius` — `sm=8, md=12, card=16, sheet=20, pill=9999`. Cards 16, sheets/dialogs 20, chips/nav/FAB pill.
- **Tap targets:** minimum 48dp (`MIN_TAP_TARGET` in theme.ts).
- **One primary action per screen.** Secondary actions live in sheets, chips, or a tap deeper — never at equal visual weight.

## Light/dark behavior
- Follows the OS by default (`useColorScheme()`), with a manual override (System / Light / Dark) in Settings → Appearance, persisted by `lib/themePreference.ts` and applied app-wide via `ThemePreferenceContext` in `App.tsx`.
- Dark elevation comes from lighter surface tones (`elevation.level*`) plus 1px `outline` borders — no shadows.

## Motion
- **Approach:** minimal-functional. Transitions only when they aid comprehension (entering screens, opening dialogs). Paper's default easing/durations; do not override.
- **No** scroll-driven motion, parallax, or "designed" entrance animations.

## Iconography
- **Brand icon:** the stamp itself — a rounded paper "C" inside a dashed
  perforated ring, the whole mark tilted −4° like a rubber-stamp imprint, on
  flat teal. (The screen-level stamps tilt −1°; the icon exaggerates it to
  read at 48px.) SVG source at `apps/mobile/assets/source/icon.svg`.
  Regenerate PNGs after editing:
  ```bash
  rsvg-convert -w 1024 -h 1024 apps/mobile/assets/source/icon.svg          -o apps/mobile/assets/icon.png
  rsvg-convert -w 1024 -h 1024 apps/mobile/assets/source/adaptive-icon.svg -o apps/mobile/assets/adaptive-icon.png
  ```
- **In-app icons:** Material Community Icons via react-native-paper. No custom icon set.
- **Icon color** inherits the current token. Active = `primary`; inactive = `onSurfaceVariant`; destructive = `error`.

## What replaced what (provenance)
- **"Ink & Mist" (2026-05-21 → 2026-07-08):** indigo `#5E63FF` single-accent system on cool neutrals, system fonts only. Replaced wholesale by "Stamped Paper" during the 2026-07 UI/UX simplicity redesign (see `AUDIT.md`): warm paper neutrals, ink-teal accent, bundled Space Grotesk/Inter, stamp motif, manual theme override.
- Theme exports renamed `inkAndMistLight/Dark` → `carnetLight/Dark` (now `CarnetTheme` with a `carnet` token extension).

## Decisions log
| Date | Decision | Rationale |
|---|---|---|
| 2026-05-21 | "Ink & Mist" palette adopted | Brown-leather skeuomorphism dated the app |
| 2026-07-08 | "Stamped Paper" replaces Ink & Mist | Redesign brief: warmer, more distinctive identity; stamp motif as the single recurring device |
| 2026-07-08 | Bundled fonts (Space Grotesk + Inter) | Distinctive typography now outweighs install-size; render gated on font load |
| 2026-07-08 | Dark `primary` = brightened `#8FCABB`; deep teal exposed as `carnet.fill` | Raw `#2C6155` fails contrast as text/icon color on ink; M3 wants a bright primary in dark schemes |
| 2026-07-08 | Stamp-red `#B4472E` fixed across modes | Destructive color must be instantly recognizable; containers carry the contrast burden on dark |
| 2026-07-08 | Dark a11y pass (review finding) | `error` text brightened to `#E27D5F` and dark secondary text to `#949188` — both palette values failed WCAG AA as dark-mode foregrounds; fills/badges keep the true hues |
| 2026-07-08 | No serif reading face | Captures are short skimmed notes; a third family costs APK size and weight discipline |
| 2026-07-08 | Icon becomes the stamp | The recolored Ink & Mist "C" predated the motif; the dashed-ring stamp mark makes the launcher icon carry the brand's one device |

---

## For AI tooling

When making any UI change in this repo:
1. Read this file first.
2. Reference tokens via `useTheme()` / `useCarnetTheme()` (`apps/mobile/src/lib/theme.ts`) — never hardcode colors, spacing, or radii.
3. Do not introduce a second accent hue or a second decorative motif beyond the stamp.
4. Do not add gradients, decorative drop shadows, or skeuomorphic textures; dark elevation = lighter surface + 1px border.
5. Every new screen/sheet/dialog must be verified in both light and dark before it ships.
6. Fonts are Space Grotesk (headings) + Inter (body/labels) only, already bundled — don't add families without amending this file.
7. In `/code-review`, flag any code that violates these rules.
