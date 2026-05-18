# Implementation Report: Photo capture mode (in-app camera)

## Summary
Added a fourth capture mode to carnet. A new "Photo" button on Home opens
`PhotoCaptureScreen`, which uses `expo-camera` to shoot a photo, accepts
optional voice/text context, runs the image through `enrichSharedImage`
(the same OmniRoute vision pipeline used by the share-target path), and
writes a paired `Photos/{slug}.jpg` + `Ideas/{slug}.md` to the vault.
Both entry points (share-target and in-app camera) now converge on the
same writer pipeline.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | High (every piece is established pattern) | High — typecheck + tests green on first run |
| Files Changed | 4 modified + 1 new = 5 | 4 modified + 1 new = 5 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extend `CaptureMode` union with `"photo"` | Complete | `packages/shared/src/types.ts` did not define a duplicate `CaptureMode` — single-source edit in `apps/mobile/src/lib/storage.ts` |
| 2 | Extend HomeScreen `formatMode` + `modeIcon` for `"photo"` | Complete | Added `"photo" → "Photo"` and `"photo" → "camera"` cases |
| 3 | Add the "Photo" button on Home | Complete | 4th button, `mode="outlined"`, `icon="camera"`, navigates to `PhotoCapture` |
| 4 | Register the `PhotoCapture` route in App.tsx | Complete | Added to `RootStackParamList` and stack |
| 5 | Create `PhotoCaptureScreen.tsx` | Complete | ~310 lines — phase machine `input → submitting → preview → saved`, permission gate, camera live view, retake/send/save, degraded-banner pattern |
| 6 | Extract `timestampSlug` / `localId` to a shared util | Skipped | Plan flagged this as optional and discouraged ("two duplications is borderline; don't do this if it'd be the only shared util in `lib/`"). Helpers duplicated inline in `PhotoCaptureScreen.tsx`, matching `ShareReceiveScreen.tsx`. |
| 7 | Manual on-device validation | Deferred to user | Build/install requires the Android device — out of scope for this agent session. |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (`npm -w @carnet/mobile run typecheck`) | Pass | Zero type errors |
| Unit Tests (`npm -w @carnet/mobile run test`) | Pass | 63/63 tests pass (writer 40, queue 10, omniroute 13). No new unit tests added — screen is UI-heavy, plan explicitly defers RN Testing Library work |
| Build | N/A | No native rebuild required — pure JS route change; `expo-camera` already linked for `CardScannerModal` |
| Integration | N/A | No server component |
| Native Manifest Check | Pass | `android.permission.CAMERA` already present in `AndroidManifest.xml:2` |
| Edge Cases | Reviewed in code | Permission denied gate, undefined `photo` guard, enrichment failure → degraded banner + stub markdown, collision-bumped paired stems, retake clears base64/markdown |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | CREATED | +310 |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATED | +14 |
| `apps/mobile/App.tsx` | UPDATED | +7 |
| `apps/mobile/src/lib/storage.ts` | UPDATED | +1 / -1 |

## Deviations from Plan
- **Task 6 skipped** — `timestampSlug` and `localId` were duplicated inline rather than extracted, per the plan's own "don't do this if it'd be the only shared util in `lib/`" guidance.
- **`packages/shared/src/types.ts`** — searched; no `CaptureMode` definition lives there, so no edit needed (the plan flagged this with "Verify before editing").
- **Branch** — created `feat/photo-capture-mode` from `main`.

## Issues Encountered
None. Typecheck passed cleanly on first run after Task 5, all unit tests stayed green.

## Tests Written
None — `PhotoCaptureScreen` is UI-heavy (camera, navigation, voice button) and not unit-testable without React Native Testing Library. The plan explicitly defers screen tests; existing writer/omniroute tests cover the underlying calls.

## Next Steps
- [ ] On-device manual validation by user (Task 7 from plan):
  - `cd apps/mobile && ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk PATH="/home/user/Android/Sdk/platform-tools:$PATH" npx expo run:android`
  - Verify: Photo button appears (4th tile, camera icon) → camera opens without dialog (permission already granted) → Capture → context inputs → Send → preview card with AI title + description → Save → returns to Home, Recents shows new "Photo" entry → workstation verification: `.jpg` in `Photos/`, `.md` in `Ideas/` with matching stem
- [ ] Code review via `/code-review`
- [ ] PR creation via `/prp-pr`
- [ ] README update — "Three capture modes" → "Four capture modes"
