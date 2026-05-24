# Local Code Review: Ink & Mist design system

**Reviewed**: 2026-05-21
**Reviewer**: self (Claude Code)
**Branch**: `feat/design-ink-and-mist` (commit `efd6792` vs `origin/main`)
**Decision**: APPROVE with comments (M1 applied in-review; L1–L4 noted)

## Summary
8 files, +293/-5. New design system replacing the brown-leather skeuomorphic identity with a flat indigo Material 3 palette + new "C" launcher icon. One real visual finding (M1: NavigationContainer header bar would mismatch the Paper-themed body) caught and fixed in-review.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M1. `NavigationContainer` had no theme prop — APPLIED**

`apps/mobile/App.tsx`. Paper handles the screen body via `PaperProvider`, but the native-stack header bar pulls from React Navigation's theme system (a separate provider chain). With no theme passed, the header used RN Navigation's `DefaultTheme` — light grey + dark text — which sits on top of our ink-dark surface in dark mode and looks bolted on.

Fix: derive an RN Navigation `Theme` object from the active `paperTheme`, mapping Paper tokens to Navigation tokens:
```ts
{
  primary:       paperTheme.colors.primary,
  background:    paperTheme.colors.background,
  card:          paperTheme.colors.surface,
  text:          paperTheme.colors.onSurface,
  border:        paperTheme.colors.outline,
  notification:  paperTheme.colors.error,
}
```
Pass to `<NavigationContainer theme={navTheme}>`. Headers now flip light↔dark in lockstep with the rest of the app.

### LOW

- **L1.** `useColorScheme()` can return `null` (system preference unknown). Null → light branch. Same behavior as pre-PR Paper default, no regression. Future: add a Settings toggle for "follow system / force light / force dark."
- **L2.** `<StatusBar style="auto">` follows the system color scheme, not the Paper theme directly. Fine; if we ever override the OS preference (L1's Settings toggle), tie StatusBar to it then.
- **L3.** Palette values exist in `theme.ts` (runtime) AND `DESIGN.md` (docs). Header comment in `theme.ts` says "if you change a value here, update DESIGN.md to match." No automation to enforce drift.
- **L4.** Indigo `#5E63FF` hardcoded in 4 places: `icon.svg`, `adaptive-icon.svg`, `app.json`, `theme.ts`. Centralizing via a build step rewriting the SVGs from a single source is overkill for now — documented in DESIGN.md's "what replaced what" section so the next contributor sees them all.

## Validation Results

| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `tsc --noEmit` clean (post-M1 fix) |
| Lint | N/A | No `lint` script |
| Tests | ✅ Pass | 131/131 across 6 files |
| Build | N/A | JS-only verifies via typecheck. Native splash/icon updates need `npx expo run:android`. |

## Files Reviewed

| File | Action | Lines | Notes |
|---|---|---|---|
| `apps/mobile/App.tsx` | Modified | +12/-3 (post-M1) | `useColorScheme()`, derived Paper+Nav themes |
| `apps/mobile/app.json` | Modified | +2/-2 | splash + adaptive bg → indigo |
| `apps/mobile/src/lib/theme.ts` | Added | +127 | `inkAndMistLight` + `inkAndMistDark` MD3 themes |
| `apps/mobile/assets/source/icon.svg` | Added | +22 | regenerable source |
| `apps/mobile/assets/source/adaptive-icon.svg` | Added | +21 | regenerable source |
| `apps/mobile/assets/icon.png` | Modified | (binary) | regenerated via `rsvg-convert` |
| `apps/mobile/assets/adaptive-icon.png` | Modified | (binary) | regenerated via `rsvg-convert` |
| `DESIGN.md` | Added | +112 | root-level design source of truth |

## Decision Rationale
Zero CRITICAL/HIGH. M1 was real visual debt waiting to happen on first dark-mode session — fixed in-review with 17 lines of theme-derivation. L1–L4 are tracked but not blocking. Native rebuild remains the only path to see splash + icon changes on device; JS theme + NavigationContainer color flow live-reload.

## Manual validation still pending
- On-device cold launch → splash now indigo, launcher icon now flat C (after `npx expo run:android`)
- Light mode → indigo accent on warm paper background, headers match
- Dark mode → indigo accent on cool ink background, headers also dark (post-M1 fix)
- Each screen (Home, Capture, Settings, RecentDetail, ShareReceive, PhotoCapture) reads cleanly with the new palette and doesn't have leftover hardcoded colors fighting the theme
