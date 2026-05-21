# Design System — Carnet ("Ink & Mist")

The visual identity for carnet, the mobile-first capture tool for Obsidian. This file is the source of truth for color, typography, surfaces, spacing, motion, and iconography. **Read this before making any visual or UI change.** The runtime tokens live in `apps/mobile/src/lib/theme.ts`; if you change a value there, mirror it here.

## Product context
- **What this is:** mobile-first knowledge capture writing plain markdown into a Syncthing-watched Obsidian vault, with self-hostable LLM enrichment via OmniRoute.
- **Who it's for:** Obsidian users (Android first) who want fast intake without opening the full vault editor on their phone.
- **Memorable thing:** the indigo C — flat, confident, opinionated. Replaces the previous chocolate-leather notebook icon that read as late-2000s skeuomorphic.

## Aesthetic direction
- **Direction:** flat, modern Material 3. One bold accent, paper/ink neutrals, semantic colors used only where they carry meaning.
- **Decoration level:** minimal. Typography and color do the work. No gradients on UI surfaces, no drop shadows for decoration (only for elevation cues handled by Paper), no patterns, no textures.
- **Mood:** confident utility. Reads as a serious tool, not a leather-bound personal journal.
- **Reference north star:** Linear's restraint and Material You's adaptive layering, applied to a mobile-first capture surface.

## Color

### Brand accent
- **`primary` (light):** `#5E63FF` — indigo. The single brand color. Used for the FAB, active states, links, focus rings, primary buttons.
- **`primary` (dark):** `#8A8FFF` — same indigo, lightened to maintain contrast on the dark ink surface.

The accent is **rare and meaningful.** Most of the screen is paper/ink/cool-gray. Indigo arrives only on actions and active state. Avoid the temptation to color icons or labels for decoration.

### Surfaces
| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#FAFAF7` | `#0F1115` | App surface. Light = warm-white "paper" with a hint of warmth (no brown). Dark = cool-tinted near-black "ink" so the indigo stays readable. |
| `surface` | `#FFFFFF` | `#171A21` | Cards, sheets, dialogs, modals. |
| `surfaceVariant` | `#EEF0F2` | `#23272F` | Code blocks, muted containers, banner backgrounds. |
| `outline` | `#D1D5DB` | `#374151` | Borders, dividers. Prefer borders over shadows for separation. |
| `outlineVariant` | `#E6E8EC` | `#23272F` | Lighter dividers (inside groups). |

### Text
| Token | Light | Dark |
|---|---|---|
| `onBackground` / `onSurface` | `#0F1115` | `#E7E9EC` |
| `onSurfaceVariant` | `#54595F` | `#9CA3AF` |

### Semantic
| Token | Light | Dark | When |
|---|---|---|---|
| `error` | `#DC2626` | `#F87171` | Destructive (Delete, error banners) |
| `errorContainer` | `#FEE2E2` | `#7F1D1D` | Filled error backgrounds |

No `success` / `warning` / `info` tokens. The intake-only flow has no positive-confirmation moments that justify green. If a future flow needs success, add it here first.

### Rules
- **No additional accent colors.** Adding a second hue dilutes the indigo.
- **No gradients** anywhere — buttons, headers, splash, anything.
- **No colored icons** in the UI body. Icons inherit `onSurface` or `primary` when active.
- **The splash + Android adaptive-icon background** is the indigo (`#5E63FF`). It is the first thing the user sees on every cold launch and should be confident.

## Typography
**System fonts only.** Roboto on Android, San Francisco on iOS — both modern, both high-quality, both already on the device. No custom-font install penalty.

Character comes from weight choices, not font choice:
- **Display / page titles** — 700 weight, large size
- **Body** — 400 weight
- **UI labels / buttons** — 500 weight
- **Captions / metadata** — 400 weight, smaller size, `onSurfaceVariant` color

The Paper M3 type scale (`displayLarge`, `headlineMedium`, `titleLarge`, `bodyMedium`, etc.) is the contract. Use `<Text variant="...">` over inline `fontSize`.

## Spacing
- **Base unit:** 4px
- **Density:** comfortable — captures are short interactions, but the user reads markdown rendered output too, so don't pack the screen.
- **Scale:** `xs=4`, `sm=8`, `md=12`, `lg=16`, `xl=24`, `2xl=32`, `3xl=48`

## Layout
- **Approach:** grid-disciplined, single column. Carnet is mobile-portrait; no editorial / asymmetric grids.
- **Max content width:** none (mobile-only at this layer; desktop is a Tauri stub).
- **Border radius:** `sm=4`, `md=8`, `lg=12` (cards), `xl=16` (sheets), `full=9999` (FABs, pills).

## Motion
- **Approach:** minimal-functional. Transitions exist only when they aid comprehension (entering screens, opening dialogs).
- **Easing:** Paper's defaults are fine; do not override.
- **Duration:** Paper's defaults are fine.
- **No** scroll-driven motion, no parallax, no "designed" entrance animations.

## Iconography
- **Brand icon:** flat indigo background with a rounded white "C" stroke. SVG source at `apps/mobile/assets/source/icon.svg`. Generated PNGs at `apps/mobile/assets/icon.png` and `apps/mobile/assets/adaptive-icon.png`. To regenerate after editing the SVG, run:
  ```bash
  rsvg-convert -w 1024 -h 1024 apps/mobile/assets/source/icon.svg          -o apps/mobile/assets/icon.png
  rsvg-convert -w 1024 -h 1024 apps/mobile/assets/source/adaptive-icon.svg -o apps/mobile/assets/adaptive-icon.png
  ```
- **In-app icons:** Material Community Icons via react-native-paper (`Icon`, `IconButton`, `List.Icon`). No custom icon set — the system already covers our needs.
- **Icon color** inherits the current token. Active state = `primary`; inactive = `onSurfaceVariant`; destructive = `error`.

## What replaced what (provenance)
- **Splash + adaptive-icon background:** `#1A1410` (warm brown) → `#5E63FF` (indigo) in `apps/mobile/app.json`.
- **App icon:** skeuomorphic brown notebook with shading, drop shadow, and perspective tilt → flat indigo + white "C".
- **PaperProvider theme:** Paper's default M3 (Google-purple) → custom `inkAndMistLight` / `inkAndMistDark` in `apps/mobile/src/lib/theme.ts`, picked at runtime via `useColorScheme()`.

## Decisions log
| Date | Decision | Rationale |
|---|---|---|
| 2026-05-21 | "Ink & Mist" palette adopted | Brown-leather skeuomorphism dated the app; needed coherent flat material identity |
| 2026-05-21 | Indigo `#5E63FF` chosen as the single accent | Pops on both light and dark, distinct from Obsidian's purple, neutral enough not to scream |
| 2026-05-21 | System fonts only | Install size + native feel beat distinctive typography for a mobile capture tool |
| 2026-05-21 | "C" letterform icon | Brandable, modern (Linear/Notion/Tana pattern), keeps the carnet=notebook semantic without leather |

---

## For AI tooling

When making any UI change in this repo:
1. Read this file first.
2. Reference theme tokens via `useTheme()` from `react-native-paper` — never hardcode colors.
3. Do not introduce a second accent color.
4. Do not add gradients, drop shadows for decoration, or skeuomorphic textures.
5. Use system fonts unless a future PR explicitly amends this file.
6. In `/code-review`, flag any code that violates these rules.
