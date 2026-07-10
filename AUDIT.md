# AUDIT.md — Carnet UI/UX Redesign Audit (2026-07-07)

Pre-implementation audit for the "radical simplicity" redesign pass. Facts verified against
the working tree on branch `fix/hermes-worklets-sharedarraybuffer`. **No code has been
changed.** Read §0 first — the brief's assumptions need two corrections before any design
work starts.

---

## 0. Corrections to the brief (must resolve before step 2)

### 0.1 The stack is Expo/React Native, not Kotlin/Compose
Carnet's mobile app is **Expo SDK 54 / React Native 0.81 / TypeScript** using
react-native-paper (Material 3) and react-navigation (native-stack). There is no Kotlin
Compose UI layer, no Remotely Save, and no Navette daemon in this repo:

- Sync = plain markdown written into a **Syncthing-watched vault folder** (no sync client
  in-app; the app just writes files).
- Network integrations = **OmniRoute** (self-hosted LLM enrichment) and optional
  **Karakeep** (bookmark service). A "navetted" migration path exists in settings and is
  live UX (do not remove).
- Kotlin exists only in generated config-plugin native code (`apps/mobile/plugins/*.js`),
  not hand-written UI.

**Implication:** every brief step translates 1:1 — Compose `MaterialTheme`/ColorScheme →
react-native-paper `MD3Theme` + `PaperProvider`; Compose font family → `expo-font` +
`useFonts`; FAB/sheets/chips → Paper equivalents. The redesign is entirely doable in the
real stack; the audit below uses RN vocabulary.

### 0.2 A deliberate design system already exists — the new direction replaces it
`DESIGN.md` ("Ink & Mist", adopted 2026-05-21) is the repo's declared source of truth for
visuals, and `apps/mobile/src/lib/theme.ts:27-127` implements it as full MD3 light+dark
themes (indigo `#5E63FF` / `#8A8FFF` accent on paper/ink neutrals). It is **not** stock
Material defaults, and it carries explicit rules that the approved direction violates:

| DESIGN.md rule | Approved direction |
|---|---|
| Single indigo accent, "no additional accent colors" (DESIGN.md:48) | Ink-teal `#2C6155` + stamp red `#B4472E` |
| System fonts only (DESIGN.md:53-54, decision log :99) | Bundled Space Grotesk + Inter |
| Minimal decoration, no recurring motif (DESIGN.md:12) | "Stamp" dashed-pill motif |
| Radius: cards 12, sheets 16 (DESIGN.md:72) | Cards/sheets 16–20dp |

**Decision needed (you flagged "ask before removing"):** proceeding means rewriting
`DESIGN.md` (palette, typography, decisions log) and `theme.ts` together — they must stay
mirrored per DESIGN.md:3. Splash + adaptive icon background are also indigo
(`app.json`, DESIGN.md:51) and would need regeneration to match the new accent, or they'll
clash on every cold launch. I'll treat "approved direction wins, DESIGN.md gets rewritten"
as the default unless you say otherwise.

### 0.3 Dark mode already works (system-follow); the gap is the manual override
`App.tsx:113-114` picks `inkAndMistDark`/`inkAndMistLight` via `useColorScheme()`, derives
a matching react-navigation theme (`App.tsx:118-129`), and `app.json` sets
`userInterfaceStyle: "automatic"`. Every Paper component inherits it. What's **missing**
is the brief's manual override toggle in Settings (no theme preference in
`lib/settings.ts`, no `Appearance` override anywhere).

---

## 1. Screen inventory

9 screens under `apps/mobile/src/screens/`, wired in a single native-stack navigator
(`App.tsx:156-201`). No bottom tabs, no drawer. Home is the hub; everything else is
push/pop.

| Screen | Lines | Role | Primary action today | Competing actions at equal weight |
|---|---|---|---|---|
| `HomeScreen.tsx` | 353 | Launcher + recents | none clearly — 5 stacked capture buttons | Idea/Journal/Contact/Photo/Audio buttons + journal shortcut + recents list + 3 header icons |
| `CaptureScreen.tsx` | 1,039 | Idea/Journal/Person text+voice capture | "Send" (`:706-713`) | attachments, tags, location all pre-Send |
| `PhotoCaptureScreen.tsx` | 507 | Camera → photo note | Capture/Save | gallery fallback, retake |
| `AudioCaptureScreen.tsx` | 549 | Record → transcribe → note | Record/Save | playback, transcribe |
| `RecentDetailScreen.tsx` | 1,458 | Note view + WYSIWYG edit | none — 5 text buttons in one row (`:1226-1277`) | Edit / Re-enrich / Transcribe / Send-to-Karakeep / Delete, all `mode="text"` |
| `ShareReceiveScreen.tsx` | 627 | Android share-sheet intake | Save | voice/text context, re-enrich |
| `SearchScreen.tsx` | 168 | Full-text search | tap result | permanently docked mode-filter chip row (`:114-135`) |
| `TagBrowserScreen.tsx` | 135 | Tag index | tap tag | — |
| `SettingsScreen.tsx` | 934 | All config | Save | 6 sections, 15 useState hooks, raw-config feel |

Capture entry points beyond the stack: Android share intent (auto-routes via
`App.tsx:79-106`), `carnet://` deep links / launcher app-shortcuts (`App.tsx:60-72`),
persistent quick-idea notification (headless, `lib/notificationQuickIdeaCapture.ts`),
voice via `VoiceButton.tsx` (1,520 lines, inline in capture screens).

## 2. Theme / token state

- **Tokens:** `lib/theme.ts` is the single runtime source; colors are clean. Only **5 stray
  hex literals** repo-wide: 4 TenTap toolbar tints in `WysiwygEditor.tsx:19-24`, 1
  `#DC2626` error badge in `RecentDetailScreen.tsx` (~:916, should be
  `theme.colors.error`), plus two translucent literals `#0001` / `#8884` in
  `RecentDetailScreen.tsx:1433,1445,1454`.
- **Spacing/typography tokens: none in code.** DESIGN.md defines a spacing scale
  (:64-67) and radius scale (:72), but screens hardcode `padding: 16`, `gap: 12`,
  `borderRadius: 12`, `fontSize: 18` etc. in local StyleSheets (e.g.
  `HomeScreen.tsx:334-353`, `CaptureScreen.tsx:1019-1039`). No `spacing`/`radius` export
  exists in `theme.ts` — the redesign theme file should add them.
- **Fonts:** system-only; no expo-font anywhere. `"monospace"` used for code/paths
  (`CaptureScreen.tsx:1025`, `RecentDetailScreen.tsx:1401,1411`, `SettingsScreen.tsx:932`).
  Bundling Space Grotesk/Inter is net-new infrastructure (expo-font + Paper
  `fonts` config), and markdown note rendering (react-native-markdown-display in
  RecentDetail + capture preview) would need its own type style.
- **Components:** 6 shared components (`TagInput`, `LocationChip`, `MarkdownToolbar`,
  `CardScannerModal`, `WysiwygEditor`, markdown image rule). There is **no shared
  Button/Card/Chip wrapper layer** — screens use Paper primitives directly with local
  styles, which is why spacing/hierarchy drift between screens.

## 3. The janky list (confirmed, with refs)

Ranked by how hard each fights the brief's goals.

1. **No single primary action on Home; capture is two taps and scroll-positioned, not
   floating.** `HomeScreen.tsx:149-198`: five full-width buttons (contained / tonal /
   outlined ×3) stacked above the fold, plus a text shortcut (`:201-209`), plus recents,
   plus 3 equal header icons (`:43-53`). No FAB exists anywhere in the app. This is the
   top structural fix. (Good news: the brief's fear that tagging/folder-picking blocks
   writing is *false* — CaptureScreen autofocuses straight into text in Idea mode,
   `CaptureScreen.tsx:886`.)
2. **Capture and browse are visually the same mode.** Every screen is the same
   native-stack header + card stack treatment. CaptureScreen shows attachments row, tag
   input, location chip, Send button, and queue/error text *around* the text field
   (`CaptureScreen.tsx:661-724`) — chrome-heavy, not distraction-free. Tagging is
   pre-save in the form (`:699-702`) rather than deferred, though it's optional.
3. **Explicit "Send" step; no auto-save.** Nothing is persisted until Send
   (`:706-713`); there is **no draft persistence** — back-press or process death during
   input loses the text (inputs only survive enrichment *errors*, `:258-266`). Journal
   and Person modes don't even autofocus (`:894-929`, `:948-1015`) and Journal/Person
   always block on a preview phase; only Idea mode has save-first-then-enrich
   (`:405-447`).
4. **RecentDetailScreen has five equal-weight actions and buries reading.**
   `:1226-1277` — Edit/Re-enrich/Transcribe/Karakeep/Delete all `mode="text"` in one
   Card.Actions row; above the content sit up to five stacked error banners
   (`:1003-1067`) and a metadata card exposing the raw file path (`:1075-1077`,
   monospace). The note text — the thing the user came for — is the fifth block down.
5. **Sync/queue status is nearly invisible.** Queue depth renders only inside
   CaptureScreen's input phase as a HelperText (`CaptureScreen.tsx:714-718`). Home,
   Search, and RecentDetail show nothing; there is no persistent indicator, no
   per-note pending-enrich badge (`lib/ideaSaveFirst.ts:36` defines
   `pending-enrich` status but no UI consumes it), and no tap-through detail. Failure
   surfacing is technical banner copy ("Saved as a raw note — AI enrichment failed",
   `CaptureScreen.tsx:803-804`).
6. **SearchScreen docks its filter chips permanently** under the searchbar
   (`SearchScreen.tsx:114-135`) — the brief wants filters collapsed until invoked.
   Search is also a separate screen from TagBrowser (`TagBrowserScreen.tsx`) with no
   shared omnibox.
7. **SettingsScreen reads as raw config.** 934 lines, 15 useState hooks, six sections
   including five expandable raw prompt-template editors and a model browser modal;
   labels like URL/API-key/model-id key-value fields. Needs grouped, plain-language
   sections (and it's where the new theme toggle lands).
8. **Inconsistent visual grammar between sibling flows.** Photo/Audio/Share screens
   each hand-roll their own layout, spinners, and button hierarchies (8 files each use
   `ActivityIndicator` with local styling); no shared "capture surface" scaffold.
9. **File-size / state debt in exactly the screens being redesigned** (context for
   sequencing, not scope creep): `RecentDetailScreen.tsx` 1,458 lines,
   `CaptureScreen.tsx` 1,039 lines with 18 useState hooks (`:106-147`),
   `SettingsScreen.tsx` 934. Per CLAUDE.md, presentation-layer rework should extract
   non-UI logic to `lib/*.ts` rather than grow these files.

## 4. What is NOT broken (don't churn it)

- Theme plumbing: one token file, `useTheme()` everywhere, light/dark auto-switch,
  nav-header theming derived from Paper tokens (`App.tsx:118-129`). The redesign swaps
  **values**, not architecture.
- Deep-link security model (`App.tsx:49-59`) — passive routes, user-confirmed writes.
  Preserve in any capture-flow change.
- Save-first + degraded-banner behavior (captures must save even when the LLM is
  unreachable) — hard product decision from prior sessions; restyle it, don't remove it.
- `lib/` modules and their ~600 tests; markdown/frontmatter byte-compatibility is a hard
  constraint (`lib/frontmatter.ts`).

## 5. Mapping the brief's goals → concrete targets

| Brief goal | Reality found | Redesign target |
|---|---|---|
| 1. One primary action per screen | Home has ~9; Detail has 5 | Home: FAB (capture) + recents; Detail: Edit primary, rest in overflow/sheet |
| 2. Fastest capture path | 2 taps, no FAB, explicit Send, no drafts | FAB → autofocused editor; draft persistence; tags deferred to post-save |
| 3. Capture vs browse modes | identical chrome | full-bleed minimal capture; card grid browse |
| 4. Card browse w/ preview+tags+sync | recents = plain List.Items, no preview/tags/status | card list with excerpt, stamp-tags, sync badge |
| 5. Quiet persistent sync indicator | HelperText in one phase of one screen | header/status dot + tap-through queue sheet; per-note pending badge |
| 6. Minimal nav, capture elevated | no tabs at all — stack + header icons | keep stack (tabs likely unnecessary for 9 screens); elevate capture via FAB on Home/browse surfaces |
| 7. Plain-language grouped settings | 6 raw sections, 15 hooks | grouped sections, secrets/advanced collapsed, + theme override toggle |

## 6. Proposed implementation order (per brief step 3, for confirmation)

1. **Theme file rewrite** — new palette tokens (light+dark), spacing/radius/type scales,
   expo-font bundling (Space Grotesk + Inter), Paper `MD3Theme` fonts config; manual
   light/dark/system override stored in `lib/settings.ts`; rewrite `DESIGN.md` to match;
   regenerate splash/adaptive-icon background color. Verify end-to-end toggle first.
2. **Nav shell + Home** — FAB, single-primary-action home, recents as cards.
3. **Capture flow** — distraction-free editor, draft persistence, deferred tagging,
   restyled degraded/queue states.
4. **Browse/search** — omnibox + collapsing filter pills, card results, stamp tags.
5. **Note detail/edit** — content-first layout, one primary action, action sheet.
6. **Sync status + Settings** — persistent quiet indicator + tap-through; grouped
   plain-language settings + theme toggle.

Each step: plan (layout, actions, empty/loading/error, light+dark) → your sign-off →
implement wired to existing `lib/` logic only. Gates: `npm -w @carnet/mobile run
typecheck` + `npm -w @carnet/mobile test` (no lint exists, by design).

## 7. Open questions for you

1. **Confirm Ink & Mist replacement** (§0.2) — rewrite DESIGN.md + splash/icon to the
   teal/paper direction?
2. **Stamp motif on sync badges:** the `-1°` rotated dashed pill is cheap in RN
   (`transform: [{rotate: "-1deg"}]` + dashed border), but dashed borders on Android
   require `borderRadius` workarounds on some RN versions — I'll validate on the
   connected Pixel during step 1 and fall back to solid-border stamps if rendering
   artifacts appear. OK?
3. **Serif for note rendering:** notes are short captures (ideas, journal snippets,
   contacts), mostly skimmed in cards; my recommendation is to keep note *rendering* in
   Inter and reserve any serif experiment for RecentDetail reading view only — or skip
   serif entirely. Bundling a third font family costs APK size and contradicts "≤2
   weights per screen" discipline.
4. **Bottom nav:** with 9 stack screens and capture-first usage, I recommend **no** tab
   bar — FAB + header search/tags/settings covers it. Confirm, or I'll prototype a
   3-tab (Notes / Capture-FAB / Settings) variant in step 2's plan.
