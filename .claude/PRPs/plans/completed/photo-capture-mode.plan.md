# Plan: Photo capture mode (in-app camera)

## Summary
Add a fourth capture mode to carnet: open the device camera from a Home button, shoot a photo, optionally add voice/text context, run it through the existing OmniRoute vision pipeline, and save the binary + AI-described markdown into the vault. Reuses every piece of the v0.2.1 share-target work (vision enrichment, SAF-aware writer, paired Photos/Ideas stems, degraded-banner pattern) and only adds the camera entry point.

## User Story
As a carnet user,
I want to tap a "Photo" button on Home to shoot directly into my vault,
So that I can capture a whiteboard / page / receipt / scene without having to take the photo elsewhere first and then share to carnet.

## Problem → Solution
**Current:** Photos enter carnet only via Android share-sheet from another app (Photos, Camera roll). A "I want to capture this right now" moment requires two app switches.
**Desired:** A first-class Photo capture mode that goes straight to the vault.

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A (planning from queue)
- **PRD Phase:** N/A
- **Estimated Files:** 4 modified + 1 new = 5

---

## UX Design

### Before
```
Home
  [Idea]
  [Journal]
  [Contact]
  Continue today's journal
  --------
  Recent (5)

  (Photo path requires leaving carnet → other app → Share → carnet)
```

### After
```
Home
  [Idea]
  [Journal]
  [Contact]
  [Photo]   ← new
  Continue today's journal
  --------
  Recent (5)

  Photo tap → in-app CameraView → Capture → preview thumbnail +
  optional voice/text context → Send → vision enrichment →
  Save → returns to Home
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Home screen buttons | 3 (Idea/Journal/Contact) | 4 (+ Photo) | Same Paper Button style |
| Photo capture entry | Share sheet only | Share sheet OR Home button | Both paths converge on the same `enrichSharedImage` + `writeBinary` + `writeIdea` |
| Recents list | Idea/Journal/Contact entries | + Photo entries with camera icon | `formatMode` + `modeIcon` extended |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | all (~300) | This is the closest analog. Reuse its phase machine (`input | saving | preview | saved`), enrichment-failure degraded banner, paired-stem write, save card UI, recordCapture call, content://-vs-file:// branching is irrelevant here (we always have base64 from the camera) |
| P0 | `apps/mobile/src/components/CardScannerModal.tsx` | 23–113 | Source of truth for the in-app camera pattern: `useCameraPermissions`, `cameraRef.takePictureAsync({ base64: true, quality: 0.6 })`, the permission-deny + permission-ungranted + ready branches, the styles for the camera view |
| P0 | `apps/mobile/src/screens/HomeScreen.tsx` | 47–145 | Where the 4th button goes and how `formatMode`/`modeIcon` must extend for the recents row |
| P0 | `apps/mobile/App.tsx` | 14–22, 70–110 | `RootStackParamList` type + `Stack.Screen` registration |
| P1 | `apps/mobile/src/lib/writer.ts` | `writeBinary`, `writeIdea`, `findCollisionFreeName` | Already does everything we need; just call it |
| P1 | `apps/mobile/src/lib/omniroute.ts` | `enrichSharedImage` | The vision call we'll reuse verbatim |
| P1 | `apps/mobile/src/lib/storage.ts` | full (34 lines) | `CaptureMode` union must add `"photo"` and `recordCapture` accepts it implicitly |
| P2 | `apps/mobile/src/screens/CaptureScreen.tsx` | the input → submitting → preview flow | Reference for the preview phase styling if we want to render the generated markdown before Save |

## External Documentation
No external research needed — every piece is established internal pattern.

---

## Patterns to Mirror

### HOME_BUTTON_PATTERN
```tsx
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:62-71
<Button
  mode="contained-tonal"
  icon="microphone"
  onPress={() => navigation.navigate("Capture", { mode: "journal" })}
  style={styles.button}
  contentStyle={styles.buttonContent}
  labelStyle={styles.buttonLabel}
>
  Journal
</Button>
```

### RECENTS_ICON_MAPPING
```ts
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:125-145
function formatMode(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea": return "Idea";
    case "journal": return "Journal";
    case "person": return "Contact";
  }
}
function modeIcon(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea": return "lightbulb-on";
    case "journal": return "microphone";
    case "person": return "account";
  }
}
```

### CAMERA_PERMISSION_FLOW
```tsx
// SOURCE: apps/mobile/src/components/CardScannerModal.tsx:24-57, 75-110
const cameraRef = useRef<CameraView>(null);
const [permission, requestPermission] = useCameraPermissions();

const grant = async () => {
  const result = await requestPermission();
  if (!result.granted) setError("Camera permission denied");
};

// Render branches:
//   !permission         → <ActivityIndicator />
//   !permission.granted → <Text>required.</Text> <Button onPress={grant}>Allow camera</Button>
//   else                → <CameraView ref={cameraRef} facing="back" /> <Button onPress={capture}>Capture</Button>
```

### CAMERA_CAPTURE
```ts
// SOURCE: apps/mobile/src/components/CardScannerModal.tsx:29-50
const photo = await cameraRef.current.takePictureAsync({
  base64: true,
  quality: 0.6,
});
if (!photo?.base64) throw new Error("no image captured");
// photo.base64  — the bytes we feed to enrichSharedImage
// photo.uri     — temp file URI; we don't need it because writeBinary takes base64
```

### VISION_ENRICH_AND_SAVE
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx (save() body)
let enrichedMd: string;
try {
  const result = await enrichSharedImage({ base64, mimeType: "image/jpeg", context: ctx });
  enrichedMd = result.markdown;
} catch (e: unknown) {
  const reason = e instanceof Error ? e.message : String(e);
  setDegradedReason(reason);
  enrichedMd = `---\ncreated: ${new Date().toISOString()}\nkind: photo\ntags: [photo]\n---\n# Photo ${slugFallback}\n\n## What's in this\n(Vision enrichment unavailable — see image.)\n\n## Context\n${ctx || "(none provided)"}`;
}

const title = deriveTitle(enrichedMd) || `Photo ${slugFallback}`;
const desiredSlug = slugify(title) || `photo-${slugFallback}`;
const { finalName } = await writeBinary("Photos", `${desiredSlug}.jpg`, base64, "image/jpeg");
const sharedStem = finalName.replace(/\.[^.]+$/, "");
const withImage = enrichedMd.replace(/^(#\s+.+\n)/m, `$1\n![](../Photos/${finalName})\n`);
const { filepath } = await writeIdea(sharedStem, withImage);
await recordCapture({ id: localId(), mode: "photo", title, filepath, createdAt: Date.now() });
```

### ROUTE_REGISTRATION
```tsx
// SOURCE: apps/mobile/App.tsx:14-22, 70+
export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
};

<Stack.Screen
  name="ShareReceive"
  component={ShareReceiveScreen}
  options={{ title: "Shared" }}
/>
```

### PHASE_MACHINE
```ts
// SOURCE: apps/mobile/src/screens/ShareReceiveScreen.tsx (Phase + state)
type Phase = "input" | "saving" | "saved";
const [phase, setPhase] = useState<Phase>("input");

// We extend: "input" (camera ready) → "submitting" (vision in flight)
//           → "preview" (markdown shown, user can edit context or accept)
//           → "saved" (post-write, show vault path + degraded banner if any)
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | CREATE | New screen — camera + enrich + save. ~250 lines following ShareReceive + CardScanner patterns. |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | Add 4th Button (icon `camera`, navigates to PhotoCapture). Extend `formatMode` + `modeIcon` for `"photo"`. |
| `apps/mobile/App.tsx` | UPDATE | Add `PhotoCapture: undefined` to `RootStackParamList`, register `<Stack.Screen name="PhotoCapture" ...>`. |
| `apps/mobile/src/lib/storage.ts` | UPDATE | Extend `CaptureMode` union with `"photo"`. |
| `packages/shared/src/types.ts` | UPDATE (maybe) | If the shared `CaptureMode` type lives there too, add `"photo"`. Verify before editing. |

## NOT Building
- **Photo editing / cropping / rotation** in carnet. The OS camera shoots, we save. Post-edit is Obsidian's job.
- **Multi-shot album / batch capture.** One photo per session. Capture again = another session.
- **Photo gallery / viewer inside carnet.** Carnet stays intake-only; Obsidian reads the vault.
- **Video.** Out of scope for v0.2.x.
- **Front-facing camera default.** Stick with `facing="back"` like CardScannerModal.
- **Replacing the share-target path.** Both entry points stay; they converge on the same writer.

---

## Step-by-Step Tasks

### Task 1: Extend `CaptureMode` to include `"photo"`
- **ACTION:** Update the `CaptureMode` union in `apps/mobile/src/lib/storage.ts` (and `packages/shared/src/types.ts` if it's also defined there).
- **IMPLEMENT:** `export type CaptureMode = "idea" | "journal" | "person" | "photo";`
- **MIRROR:** Existing union shape in storage.ts:6.
- **IMPORTS:** None new.
- **GOTCHA:** TypeScript exhaustiveness checks in `formatMode`/`modeIcon` switches will fail without the new case — task 2 must follow immediately or typecheck breaks.
- **VALIDATE:** `npm -w @carnet/mobile run typecheck` shows the new error in HomeScreen (signal that the union widened); becomes clean after task 2.

### Task 2: Extend Home recents rendering for `photo`
- **ACTION:** Update `formatMode` and `modeIcon` in `apps/mobile/src/screens/HomeScreen.tsx` to handle `"photo"`.
- **IMPLEMENT:**
  ```ts
  case "photo": return "Photo";  // formatMode
  case "photo": return "camera"; // modeIcon
  ```
- **MIRROR:** `RECENTS_ICON_MAPPING` pattern above.
- **IMPORTS:** None new.
- **VALIDATE:** Typecheck clean. No visual change yet (no photo entries in recents until task 6 fires).

### Task 3: Add the "Photo" button on Home
- **ACTION:** In `apps/mobile/src/screens/HomeScreen.tsx`, add a 4th `<Button>` after the Contact button.
- **IMPLEMENT:**
  ```tsx
  <Button
    mode="outlined"
    icon="camera"
    onPress={() => navigation.navigate("PhotoCapture")}
    style={styles.button}
    contentStyle={styles.buttonContent}
    labelStyle={styles.buttonLabel}
  >
    Photo
  </Button>
  ```
- **MIRROR:** `HOME_BUTTON_PATTERN`.
- **IMPORTS:** None new (`navigation` already typed via RootStackParamList).
- **GOTCHA:** `navigation.navigate("PhotoCapture")` typechecks ONLY after task 4 registers the route.
- **VALIDATE:** Tap on phone shows a placeholder screen (task 5 will fill it).

### Task 4: Register the `PhotoCapture` route in App.tsx
- **ACTION:** Update `RootStackParamList` and add a `<Stack.Screen>`.
- **IMPLEMENT:**
  ```ts
  // RootStackParamList
  PhotoCapture: undefined;

  // After ShareReceive Screen
  <Stack.Screen
    name="PhotoCapture"
    component={PhotoCaptureScreen}
    options={{ title: "Photo" }}
  />
  ```
- **MIRROR:** `ROUTE_REGISTRATION`.
- **IMPORTS:** `import PhotoCaptureScreen from "./src/screens/PhotoCaptureScreen";`
- **GOTCHA:** Native rebuild NOT required — pure JS route change, hot reload picks it up.
- **VALIDATE:** Typecheck clean; tapping the new Home button navigates without error.

### Task 5: Create `PhotoCaptureScreen.tsx`
- **ACTION:** New file at `apps/mobile/src/screens/PhotoCaptureScreen.tsx`. ~250 lines. Owns the camera + capture + enrich + save flow.
- **IMPLEMENT (sketch — full code follows the patterns):**
  ```tsx
  // imports: useRef/useState/useEffect/useMemo from react;
  // ScrollView, StyleSheet, View, Image from react-native;
  // ActivityIndicator, Banner, Button, Card, HelperText, Text, TextInput from react-native-paper;
  // NativeStackScreenProps from @react-navigation/native-stack;
  // CameraView, useCameraPermissions from expo-camera;
  // RootStackParamList from "../../App";
  // VoiceButton from "../voice/VoiceButton";
  // recordCapture from "../lib/storage";
  // extFromMime, writeBinary, writeIdea, slugify from "../lib/writer";
  // enrichSharedImage from "../lib/omniroute";
  // deriveTitle from "@carnet/shared";

  type Phase = "input" | "submitting" | "preview" | "saved";

  export default function PhotoCaptureScreen({ navigation }: Props) {
    const cameraRef = useRef<CameraView>(null);
    const [permission, requestPermission] = useCameraPermissions();
    const [phase, setPhase] = useState<Phase>("input");
    const [base64, setBase64] = useState<string | null>(null);
    const [thumbUri, setThumbUri] = useState<string | null>(null);
    const [context, setContext] = useState("");
    const [transcript, setTranscript] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [degradedReason, setDegradedReason] = useState<string | null>(null);
    const [enrichedMd, setEnrichedMd] = useState<string>("");
    const [savedFilepath, setSavedFilepath] = useState<string | null>(null);

    const combinedContext = useMemo(...);  // mirror ShareReceive

    // capture: takePictureAsync({ base64: true, quality: 0.6 }), set base64+thumb, do NOT auto-send
    // send:    enrichSharedImage → setEnrichedMd → phase = "preview"
    //          on failure → setDegradedReason + stub markdown (mirror ShareReceive)
    // save:    writeBinary + writeIdea (shared stem) → recordCapture → phase = "saved"
    // retake:  reset base64/enrichedMd/phase back to "input"

    // Render branches:
    //   permission gates (mirror CardScanner)
    //   phase === "input"      → <CameraView /> + [Capture] button (or, if base64 set, show thumb + context inputs + [Retake] + [Send])
    //   phase === "submitting" → spinner + "OmniRoute is structuring the photo…"
    //   phase === "preview"    → Card showing enrichedMd + [Edit context] + [Save]
    //   phase === "saved"      → Card with savedFilepath + degradedReason Banner if set + [Done]
  }
  ```
- **MIRROR:** Combine `CAMERA_PERMISSION_FLOW`, `CAMERA_CAPTURE`, `VISION_ENRICH_AND_SAVE`, `PHASE_MACHINE`. Use `localId()` + `timestampSlug()` helpers copied from ShareReceiveScreen (or extracted to a shared util — task 7).
- **IMPORTS:** See sketch above.
- **GOTCHA:**
  - The MAX_SHARED_IMAGE_BYTES cap from ShareReceive doesn't apply here because we control the quality (0.6) so the file is bounded. Skip the cap.
  - Camera permission may already be granted from CardScanner — still call `useCameraPermissions()`; expo handles the cached state.
  - `takePictureAsync` returns `undefined` for `photo` (not `photo.base64`) when the user backgrounds the app mid-shoot. Guard explicitly.
  - Mime type: takePictureAsync produces JPEG. Hardcode `"image/jpeg"` for the call to `enrichSharedImage` + `writeBinary`.
- **VALIDATE:**
  - Typecheck + tests pass.
  - On device: tap Photo button → camera shows → tap Capture → thumbnail appears → optional context typed → Send → ~1-3s spinner → preview card with markdown → Save → toast/done card → Home.
  - File lands in `Photos/{slug}-{stamp}.jpg` and `Ideas/{slug}-{stamp}.md` (same stem).

### Task 6: Optional — extract `timestampSlug` and `localId` to a shared util
- **ACTION:** If both ShareReceiveScreen and PhotoCaptureScreen need these helpers, lift them to `apps/mobile/src/lib/ids.ts` rather than duplicating.
- **IMPLEMENT:** Two pure functions, ~10 lines.
- **MIRROR:** Existing definitions in ShareReceiveScreen.tsx:42–63.
- **IMPORTS:** Import in both screens.
- **GOTCHA:** Don't do this if it'd be the only shared util in `lib/`. Three small duplications is acceptable; two is borderline.
- **VALIDATE:** Both screens still typecheck + tests pass.

### Task 7: Manual on-device validation
- **ACTION:** Build + install on phone, exercise the full flow.
- **IMPLEMENT:** Run `cd apps/mobile && ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk PATH="/home/user/Android/Sdk/platform-tools:$PATH" npx expo run:android`. JS-only changes → no native rebuild required IF expo-camera was already linked (it was, for CardScannerModal). Verify by reading `apps/mobile/android/app/src/main/AndroidManifest.xml` — camera permission already present.
- **VALIDATE:**
  - Cold launch → Home → "Photo" button visible (4th tile).
  - Tap Photo → camera permission already granted (no dialog).
  - Tap Capture → thumbnail + context inputs appear.
  - Tap Send → vision call → preview with real title (not "Photo 20260518-...").
  - Tap Save → returns to Home; entry visible in Recents with `camera` icon.
  - File in vault: `{SAF folder}/Photos/{slug}-{stamp}.jpg` + `{SAF folder}/Ideas/{slug}-{stamp}.md`.

---

## Testing Strategy

### Unit Tests
PhotoCaptureScreen is UI-heavy (camera, navigation) and not unit-testable without RN Testing Library. Defer screen tests; rely on type safety + manual validation.

Pure-function tests if Task 6 happens:
| Test | Input | Expected | Edge |
|---|---|---|---|
| `timestampSlug` | now=2026-05-18 12:30:00 | `"20260518-123000"` | no |
| `localId` | (called) | matches `/^[a-z0-9]+-[a-z0-9]{8}$/` | uniqueness across rapid calls |

### Edge Cases Checklist
- [ ] Permission denied — show clear message + "Open Settings" link
- [ ] User taps Capture but app backgrounds before frame returns — `photo` is undefined, guard
- [ ] User taps Send without typing context — empty context is valid, prompt accepts it
- [ ] OmniRoute key not configured — `enrichSharedImage` throws → degraded banner + stub save
- [ ] OmniRoute returns 502 (the upstream-flake case from v0.2.0) — same degraded path
- [ ] Two photos shot in quick succession that derive the same AI title — collision-bump preserves both
- [ ] User backs out mid-preview — state cleared, no orphaned binary on disk (we only write binary inside Save)

---

## Validation Commands

### Static Analysis
```bash
npm -w @carnet/mobile run typecheck
```
EXPECT: Zero type errors.

### Unit Tests
```bash
npm -w @carnet/mobile run test
```
EXPECT: All tests pass (no new tests required for the screen itself; existing writer/omniroute tests cover the underlying calls).

### Native Rebuild Check
```bash
# Verify no plugin/manifest change is needed
grep -c "android.permission.CAMERA" apps/mobile/android/app/src/main/AndroidManifest.xml
```
EXPECT: `1` (already there from expo-camera plugin).

### On-Device
```bash
cd apps/mobile && ANDROID_HOME=/home/user/Android/Sdk ANDROID_SDK_ROOT=/home/user/Android/Sdk PATH="/home/user/Android/Sdk/platform-tools:$PATH" npx expo run:android
```
EXPECT: BUILD SUCCESSFUL → install → app launches; Photo button on Home; full flow works.

### Manual Validation
- [ ] Photo button appears on Home (4th tile, camera icon)
- [ ] Tap → camera opens immediately (no dialog if permission already granted)
- [ ] Capture → preview thumbnail shows
- [ ] Send → spinner → preview card with AI-generated title + description
- [ ] Save → returns to Home, Recents shows new "Photo" entry with camera icon
- [ ] Verify on workstation: `.jpg` in `Photos/`, `.md` in `Ideas/` with matching stem, markdown references the photo correctly via `../Photos/{filename}`

---

## Acceptance Criteria
- [ ] Tapping "Photo" on Home opens the in-app camera
- [ ] Captured photo is saved as a binary in the vault `Photos/` subdir
- [ ] Markdown note in `Ideas/` references the photo via relative path with matching stem
- [ ] AI-generated title appears in both the recents list and the markdown H1
- [ ] Degraded banner shows on enrichment failure (no silent fallback)
- [ ] All static checks green
- [ ] No regressions in share-target flow or in idea/journal/person captures

## Completion Checklist
- [ ] Mirrors existing patterns (CameraView, vision enrich, paired-stem write)
- [ ] No new external deps
- [ ] No native rebuild needed
- [ ] CaptureMode extension covers storage history correctly
- [ ] Recents icon `camera` renders
- [ ] Photo file is JPEG (`image/jpeg`, `.jpg` extension)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `expo-camera` permission state stale after the CardScanner permission was granted earlier | Low | Low (extra dialog) | Same `useCameraPermissions()` hook handles cached state |
| Camera ref `null` during the brief mount window if user taps too fast | Low | Annoying | `if (!cameraRef.current) return;` guard (mirror CardScanner) |
| In-memory base64 holds for several seconds during vision call → memory pressure on low-end devices | Low | Medium | Camera `quality: 0.6` keeps a typical photo well under 2 MB; vastly under MAX_SHARED_IMAGE_BYTES (8 MB) cap |
| User retakes 5 photos in a row without saving — temp base64 keeps swapping | Negligible | Negligible | GC handles it; no leak |
| Vision model is configured to a non-vision model (text-only) → enrichment fails | Medium | Medium | Degraded banner already surfaces the error message; user can switch model in Settings |

## Notes
- Both entry points (share-target + this photo mode) converge on the same `enrichSharedImage` + `writeBinary("Photos", ...)` + `writeIdea(stem, withImageEmbed)` pipeline. Any future change to that pipeline benefits both paths automatically.
- The `kind: photo` (or possibly `kind: shared-image` for parity?) frontmatter value is a small UX decision. Recommend `kind: photo` for camera-source photos so the user can `dataview` filter the two paths separately. Decide during implementation.
- README's "Three capture modes" section will become "Four capture modes" — update with this PR.
