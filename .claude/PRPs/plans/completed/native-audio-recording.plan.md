# Plan: Native audio recording (slate #4, recording-only)

## Summary
Add a 5th capture mode: "Audio". Tap the new button on Home → recording screen with a big record button + elapsed timer → tap to start, tap to stop → saves a raw `.m4a` to `Audio/` and a stub markdown to `Ideas/` with the same shape as PR #7's `kind: shared-audio` notes. No transcription this PR — that's the natural follow-up (OmniRoute Whisper-path).

## User Story
As a carnet user who wants to capture a quick voice memo,
I want to tap "Audio" on Home, record, and save with one more tap,
So that the audio lands in my Obsidian vault without me leaving carnet to use Pixel Recorder + sharing back in.

## Problem → Solution
**Current:** To save an audio note to carnet, the user has to: open Pixel Recorder (or similar) → record → tap share → choose carnet from the share sheet → review the ShareReceive screen → Save. Five surface switches.

**Desired:** Open carnet → Audio → record → Save. Three taps. The file ends up in the same `Audio/{slug}.m4a` + `Ideas/{slug}.md` location, with the same `kind: shared-audio` frontmatter — so it shows up alongside share-audio captures and behaves identically downstream (delete, retro-enrich-when-transcription-lands, etc.).

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A — slate item #4 from the market-research feature menu
- **PRD Phase:** v0.3
- **Estimated Files:** 1 new + 4 modified
- **Confidence Score:** 9/10 — every primitive exists (expo-av Audio.Recording in VoiceButton; writeBinary + writeIdea pattern from PR #7's audio-share branch; CaptureMode type extension is one line)

---

## UX Design

### Flow
```
Home  ────────────────►  AudioCapture (idle)
[Idea] [Journal]              ┌──────────────────┐
[Contact] [Photo]             │                  │
[Audio]  ← NEW                │     ●━━━━━━━     │  Big indigo record
                              │   Record audio   │  button (FAB-style)
                              │                  │
                              └──────────────────┘
                                      │
                                      ▼ tap
                              ┌──────────────────┐
                              │      ●  REC      │  Pulses while recording
                              │   00:23          │  Live timer
                              │                  │
                              │   ▣  Stop & save │  Stop button (indigo)
                              │   ✕  Cancel      │  Discards recording
                              └──────────────────┘
                                      │
                                      ▼ stop
                              ┌──────────────────┐
                              │ Saved to vault   │  Same shape as ShareReceive
                              │ Audio/foo.m4a    │  saved-phase
                              │ Ideas/foo.md     │
                              │ [Done]           │
                              └──────────────────┘
                                      │
                                      ▼ tap Done
                              Home (recents refreshed)
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Home buttons | 4 (Idea/Journal/Contact/Photo) | 5 (+ Audio) | New button styled to match the rest |
| AudioCapture screen | doesn't exist | new screen, 3 phases (idle → recording → saved) | Mirrors PhotoCaptureScreen's phase shape |
| `carnet://audio` deep link | unmapped | routes to AudioCapture | Sets up future app-shortcut entry |
| Recents list | 4 modes shown | + "Audio" mode with mic icon | `CaptureMode` union extended |
| RecentDetail on an audio capture | (any audio capture today comes from share intent) | identical — the saved markdown shape matches | Delete + soft-archive already handle Audio/ binaries (PR #8's moveToArchive walks Photos|Audio|Files) |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/voice/VoiceButton.tsx` | 921-997 | The `startWhisper` / `finishWhisper` pattern — exact expo-av Audio.Recording calls to mirror |
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | (audio branch ~210-260) | The stub-markdown shape + `writeBinary("Audio", …)` + `writeIdea(...)` flow to mirror |
| P0 | `apps/mobile/src/screens/PhotoCaptureScreen.tsx` | (all ~360 lines) | Phase machine (`input` → `saving` → `saved`) + Card + Snackbar pattern for the recording UX |
| P0 | `apps/mobile/src/lib/storage.ts` | 6 | `CaptureMode` union — extend with `"audio"` |
| P0 | `apps/mobile/src/screens/HomeScreen.tsx` | (Button block + `formatMode` + `modeIcon` helpers) | Add the 5th button + extend the mode helpers |
| P0 | `apps/mobile/App.tsx` | RootStackParamList + Stack.Screen list + linking | Register `AudioCapture` screen + add `audio` route to linking config |
| P1 | `apps/mobile/src/lib/shareHelpers.ts` | (MAX_SAFE_SHARE_BYTES, BASE64_EXPANSION) | Reuse the size cap so a 30-minute accidental recording doesn't OOM |
| P1 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | (formatMode + canReEnrich) | Add `"audio"` to formatMode — DON'T add to canReEnrich (no enrichment exists for audio yet) |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| expo-av recording start | `VoiceButton.tsx:935-941` | `Audio.setAudioModeAsync(...)` + `Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY)` |
| Recording stop + URI | `VoiceButton.tsx:963-965` | `await recording.stopAndUnloadAsync()` + `recording.getURI()` |
| Mic permission | `VoiceButton.tsx:926` | `Audio.requestPermissionsAsync()` |
| Save audio binary | `ShareReceiveScreen.tsx` audio branch | `writeBinary("Audio", `${slug}.${ext}`, base64, mime)` |
| Stub markdown shape | `ShareReceiveScreen.tsx` audio branch | `kind: shared-audio` + `## File` + `## Context` blocks |
| recordCapture for recents | every existing capture screen | `recordCapture({ id, mode, title, filepath, createdAt })` |
| Slug for capture | `ShareReceiveScreen.tsx` | `slugify(baseName) || `shared-audio-${slugFallback}`` |

---

## Patterns to Mirror

### EXPO_AV_RECORD (from VoiceButton.tsx:921-997)
```ts
import { Audio } from 'expo-av';
// ...
const { granted } = await Audio.requestPermissionsAsync();
if (!granted) { /* show permission denied UI */ return; }
await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
// ... user taps stop ...
await recording.stopAndUnloadAsync();
const uri = recording.getURI();  // file:// path in cache dir
```

### AUDIO_BRANCH_SAVE (from ShareReceiveScreen.tsx audio branch, PR #7)
```ts
// 1. Read the file as base64
const base64 = await FileSystem.readAsStringAsync(uri, {
  encoding: FileSystem.EncodingType.Base64,
});

// 2. Size cap (reuse shareHelpers' constants)
if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) throw new Error(...);

// 3. Sanitize a filename slug (use timestamp since there's no source name)
const slugFallback = timestampSlug();
const desiredSlug = `audio-${slugFallback}`;

// 4. Write binary
const { finalName } = await writeBinary("Audio", `${desiredSlug}.m4a`, base64, "audio/mp4");
const sharedStem = finalName.replace(/\.[^.]+$/, "");

// 5. Write the stub markdown — match the shared-audio shape so downstream
//    code (RecentDetail render, moveToArchive paired-binary detection,
//    future re-enrich) doesn't need to learn a new kind value.
const mdNote =
  `---\n` +
  `created: ${new Date().toISOString()}\n` +
  `kind: shared-audio\n` +
  `source: ${yamlQuote(finalName)}\n` +
  `mime: ${yamlQuote("audio/mp4")}\n` +
  `size: ${base64Bytes(base64)}\n` +
  `tags: [shared, audio]\n` +
  `---\n` +
  `# Audio note: ${finalName}\n\n` +
  `## File\n[${finalName}](../Audio/${finalName})\n\n` +
  `## Context\n${context || "(none provided)"}\n`;

const { filepath } = await writeIdea(sharedStem, mdNote);

// 6. Recents
await recordCapture({
  id: localId(),
  mode: "audio",  // ← new mode value
  title: `Audio note: ${finalName}`,
  filepath,
  createdAt: Date.now(),
});
```

### CAPTURE_MODE_EXTENSION (storage.ts)
```ts
- export type CaptureMode = "idea" | "journal" | "person" | "photo";
+ export type CaptureMode = "idea" | "journal" | "person" | "photo" | "audio";
```
This single line cascades — `formatMode` switches in HomeScreen.tsx and RecentDetailScreen.tsx will trip exhaustive-check warnings, forcing me to add the `audio` case at each call site.

### NAV_PARAM_REGISTRATION (App.tsx)
```ts
export type RootStackParamList = {
  // ... existing ...
+ AudioCapture: undefined;  // same as PhotoCapture — no params
};

// Stack.Screen:
+ <Stack.Screen
+   name="AudioCapture"
+   component={AudioCaptureScreen}
+   options={{ title: "Audio" }}
+ />

// linking config:
config: {
  screens: {
    // ... existing ...
+   AudioCapture: "audio",
  },
},
```

### HOME_BUTTON_5TH (HomeScreen.tsx)
Mirror the existing button row exactly — same `Button` component shape, same icon convention. Add after Photo:
```tsx
<Button
  mode="outlined"
  icon="microphone-outline"
  onPress={() => navigation.navigate("AudioCapture")}
  style={styles.button}
  contentStyle={styles.buttonContent}
  labelStyle={styles.buttonLabel}
>
  Audio
</Button>
```
Plus extend `formatMode` and `modeIcon` switches:
```ts
function formatMode(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    // ... existing ...
    case "audio": return "Audio";
  }
}
function modeIcon(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    // ... existing ...
    case "audio": return "microphone";
  }
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/screens/AudioCaptureScreen.tsx` | CREATE | The new capture screen. ~200 lines |
| `apps/mobile/src/lib/storage.ts` | UPDATE | Add `"audio"` to `CaptureMode` union |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | 5th button + `formatMode`/`modeIcon` cases |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | `formatMode` `audio` case (only — `canReEnrich` stays false for audio) |
| `apps/mobile/App.tsx` | UPDATE | Register `AudioCapture` route + linking entry |

## NOT Building
- **Transcription via OmniRoute Whisper-path** — separate follow-up PR. Saves on the same `kind: shared-audio` markdown shape so when transcription lands it can append to existing audio notes.
- **Waveform visualization during recording** — would need a 3rd-party RN audio-vis lib or custom drawing. Out of scope; a static "REC" indicator + timer is enough.
- **Pause/resume during recording** — defer. expo-av supports it (`recording.pauseAsync()`) but the UX surface adds complexity. Single-shot record-then-stop is the v0.3 ask.
- **Manual filename / title input before save** — uses a timestamp slug like share-audio does today. Edit-in-Obsidian is the rename path.
- **An audio app-shortcut entry** — would be a one-line addition to `withAppShortcuts.js` but only useful once recording UX is validated. Defer to a follow-up.
- **Max recording duration cap** — relies on the existing `MAX_SAFE_SHARE_BYTES` (200 MB) for OOM protection. A 30-minute high-quality m4a is ~30 MB; we have plenty of headroom.
- **iOS recording** — iOS isn't shipping yet. The `Audio.setAudioModeAsync({allowsRecordingIOS: true})` flag is set so when iOS lands it works, but the manifest + permission flow needs separate iOS plumbing then.

---

## Step-by-Step Tasks

### Task 1: Extend `CaptureMode` union in storage.ts
- **ACTION:** Edit `apps/mobile/src/lib/storage.ts`.
- **IMPLEMENT:** Single line — add `| "audio"` to the union. Existing tests are unaffected (storage tests use literal `"idea"` for their `entry()` helper).
- **MIRROR:** `CAPTURE_MODE_EXTENSION`.
- **VALIDATE:** typecheck — exhaustive switches in HomeScreen.tsx + RecentDetailScreen.tsx will now error, surfacing the call sites to update.

### Task 2: Update `formatMode` / `modeIcon` exhaustive switches
- **ACTION:** Edit `HomeScreen.tsx` + `RecentDetailScreen.tsx`.
- **IMPLEMENT:** Add `case "audio": return "Audio";` to `formatMode` and `case "audio": return "microphone";` to `modeIcon` (HomeScreen only — RecentDetail doesn't have modeIcon).
- **VALIDATE:** typecheck clean.

### Task 3: Add 5th Home button
- **ACTION:** Edit `HomeScreen.tsx`. Add `Button` for Audio after Photo in the existing button stack.
- **MIRROR:** `HOME_BUTTON_5TH`.
- **IMPLEMENT:** `mode="outlined"` matches Contact + Photo. `icon="microphone-outline"` to differentiate from Journal's `microphone` (both can use microphone iconography — Journal is voice→text, Audio is voice→raw-file; outlined-vs-filled gives a subtle visual cue without needing a different glyph).
- **VALIDATE:** Manual on-device — visual check the button appears + lands on the right screen.

### Task 4: Create AudioCaptureScreen.tsx
- **ACTION:** Create `apps/mobile/src/screens/AudioCaptureScreen.tsx` (~200 lines).
- **IMPLEMENT:**
  - 3-phase state machine: `"idle" | "recording" | "saved"`
  - Recording state: `Audio.Recording | null` in a ref (matches VoiceButton's pattern)
  - Elapsed-time state: `number` (seconds), updated via `setInterval` while recording
  - Permissions handled at start; clear "permission needed" banner if denied (matches existing screens)
  - On stop: read URI as base64 → `writeBinary("Audio", ...)` → `writeIdea(...)` → `recordCapture(...)` → transition to `"saved"` phase
  - Saved phase: `Card` with file path + Done button (matches PhotoCaptureScreen)
  - On unmount mid-recording: `recording.stopAndUnloadAsync()` to avoid orphaned mic handle
  - Use the `sanitizeShareString`/`yamlQuote` helpers from `shareHelpers.ts` for the stub markdown values
  - Style the record button using `theme.colors.primary` (indigo); pulse animation while recording via `Animated.Value` (mirror VoiceButton's pulse)
- **MIRROR:** `EXPO_AV_RECORD` (lifecycle), `AUDIO_BRANCH_SAVE` (post-stop save flow), PhotoCaptureScreen's phase shape + saved card.
- **IMPORTS:**
  ```ts
  import { Audio } from "expo-av";
  import * as FileSystem from "expo-file-system/legacy";
  import { writeBinary, writeIdea, slugify } from "../lib/writer";
  import { recordCapture } from "../lib/storage";
  import {
    MAX_SAFE_SHARE_BYTES,
    BASE64_EXPANSION,
    sanitizeShareString,
    yamlQuote,
  } from "../lib/shareHelpers";
  ```
- **GOTCHA:**
  - `Audio.Recording` instance must be cleared from the ref AFTER `stopAndUnloadAsync` — calling stop twice on the same instance throws "Recording already unloaded" on Android.
  - The recording URI is a file:// path in the app's CACHE dir — survives long enough for our read but NOT across process restart. Read base64 BEFORE leaving the saving phase.
  - Set `Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true })` BEFORE `createAsync` — Android tolerates skipping it, iOS doesn't.
  - The size check (`base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION`) should fire BEFORE writeBinary — a 250 MB audio file would OOM the JS heap during writeBinary's serialization.
  - Use `kind: shared-audio` (not `audio-capture` or similar) in the stub frontmatter — keeps RecentDetail's render + moveToArchive's paired-binary detection working without changes. The capture mode in recents differs from the kind in frontmatter, which is fine.
  - The "Cancel" action during recording should call `stopAndUnloadAsync` AND skip the save path — and ideally delete the URI from cache via `FileSystem.deleteAsync(uri, {idempotent: true})` so we don't leak ~MB to the cache dir.
- **VALIDATE:** Task 6 manual checklist.

### Task 5: Register AudioCapture in App.tsx
- **ACTION:** Edit `apps/mobile/App.tsx`. Add to `RootStackParamList`, import the screen, add `Stack.Screen` entry, add `linking.config.screens.AudioCapture: "audio"`.
- **MIRROR:** `NAV_PARAM_REGISTRATION`.
- **IMPORTS:** `import AudioCaptureScreen from "./src/screens/AudioCaptureScreen"`.
- **GOTCHA:**
  - The deep-link prefix is `carnet://audio` (not `carnet://capture/audio`) — keeps it parallel to `carnet://photo` for the future app-shortcut entry.
- **VALIDATE:** Task 6 manual flow — `adb shell am start -W -a android.intent.action.VIEW -d "carnet://audio" us.beary.carnet` should land on AudioCapture (sanity check the linking config).

### Task 6: Validate + on-device hand-off
- **ACTION:** `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`. Then surface the rebuild command for the user.
- **EXPECT:** 0 type errors; 161 tests still pass (no new tests — recording-UI behavior + expo-av integration aren't unit-testable without heavy mocking that would test the mock more than the code).
- **REBUILD:** `npm run android` (uses PR #12's wrapper). Required because nothing native changed — JS-only? Actually the only native change is whether we add the new `audio` shortcut to `withAppShortcuts.js`. We said NOT this PR. So this is JS-only and live-reloads with R, R on the dev client.

---

## Testing Strategy

### Unit Tests
**None.** The two things in this PR that could have unit tests are:
- The stub markdown construction — a string concatenation. Snapshot would test the strings I wrote are the strings I wrote.
- The recording state machine — would require mocking `expo-av`'s entire Audio module, which is more test-the-mock than test-the-code.

Coverage relies on:
- Existing 161-test suite (no regression from the CaptureMode extension — TypeScript exhaustive checks catch any miss)
- The downstream save path (writeBinary + writeIdea + recordCapture) is already unit-tested via writer.test.ts
- Manual on-device validation for the recording-specific UX

### Edge Cases Checklist
- [ ] Tap record → permission dialog → grant → recording starts (first-launch path)
- [ ] Tap record → permission dialog → deny → "permission needed" banner with link to App Settings
- [ ] Record → tap Stop & save → file lands at `Audio/audio-{timestamp}.m4a`; markdown at `Ideas/audio-{timestamp}.md`
- [ ] Record → tap Cancel → no file written; cache file deleted
- [ ] Record → navigate away (back button) → `useEffect` cleanup calls stopAndUnloadAsync; no orphaned recording
- [ ] Record for >5 minutes → file size + base64 read still completes (modern phones handle 50MB+ files fine)
- [ ] Record → another app takes audio focus (incoming call) → Android pauses our recording → our stop call returns the partial file
- [ ] Two AudioCaptureScreen mounts (deep-link arriving while one is open) → second mount's `Audio.Recording.createAsync` would fail because only one recording at a time on Android — handle the error path gracefully (show banner, don't crash)
- [ ] Save with no captured audio (record < 100ms) → m4a file exists but is empty — write it anyway; user can delete from recents

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 161/161 pass (unchanged — no new tests).

### Deep-link sanity check (after install)
```bash
adb shell am start -W -a android.intent.action.VIEW -d "carnet://audio" us.beary.carnet
```
EXPECT: app opens directly to AudioCaptureScreen.

### On-device
```bash
cd apps/mobile && npm run android
```
EXPECT: app installs; Home shows 5th button "Audio"; tapping it opens the new screen.

### Manual Validation
- [ ] Home shows 5 buttons (Idea / Journal / Contact / Photo / Audio)
- [ ] Audio button → AudioCapture screen with the big record button
- [ ] Tap record → permission prompt (first time) → recording starts → timer increments → indigo pulse on the button
- [ ] Tap Stop & save → "Saved to vault" card → file path shown → Done → back to Home
- [ ] New entry appears in recents with the mic icon and "Audio · 5s ago" subtitle
- [ ] Tap the recent → RecentDetail renders the stub markdown with the `../Audio/...` link
- [ ] Long-press the recent → enters selection mode (PR #11 still works)
- [ ] Delete from RecentDetail → both .md and .m4a move to Archive/ (PR #8's moveToArchive handles it because the link → `../Audio/...` matches the regex)
- [ ] Record → tap Cancel → no file in Audio/ or Ideas/
- [ ] Record → back button → no orphaned mic indicator in the system status bar
- [ ] Regression: existing capture flows (Idea / Journal / Contact / Photo) still work
- [ ] Regression: share-audio (PR #7) still works

---

## Acceptance Criteria
- [ ] Home has 5 capture buttons; new "Audio" button visible + functional
- [ ] AudioCapture screen records via expo-av's Audio.Recording
- [ ] Recording timer increments live; UI pulses to signal active recording
- [ ] Stop & save writes `Audio/{slug}.m4a` + `Ideas/{slug}.md` with `kind: shared-audio`
- [ ] Recents include the new capture with `mode: "audio"` + mic icon
- [ ] Cancel during recording cleans up cache file
- [ ] Unmount mid-recording stops + unloads (no orphaned mic)
- [ ] `CaptureMode` union extended to include `"audio"`; all exhaustive switches updated
- [ ] No type errors; 161 tests still pass

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mic permission dialog flashes weirdly on first launch (Android 14 quirk) | Low | Confusing first-time UX | Permission flow mirrors VoiceButton's known-good path |
| Two simultaneous recordings (rare race) crash expo-av | Low | App crash | Wrap createAsync in try/catch; on failure show "Recording already in progress" banner |
| Cache file orphaned in app cache dir on crash | Medium | Disk space grows over time | Android wipes app cache when it needs space; acceptable. Adding a startup cleanup is overkill |
| Recording file size > MAX_SAFE_SHARE_BYTES (200 MB) | Very low | OOM during writeBinary | Pre-check before base64 read; hard error with friendly message |
| RecentDetail's markdown renderer doesn't render audio file link as a media player | Medium | User sees a text link, not a play button | Documented in NOT Building. Tapping the link in Obsidian on desktop opens the file in the native player. Inline mobile playback is a future PR. |
| Pulse animation steals frames during recording on low-end devices | Very low | Stuttering UI | Animated.Value with useNativeDriver = true handles it cleanly |

## Notes
- The capture's `kind: shared-audio` mirrors PR #7 deliberately. When the transcription follow-up lands, it'll work for BOTH share-audio AND audio-capture without branching. The `mode: "audio"` in CaptureEntry is the visual marker for the Home recents row (different from the frontmatter kind).
- A natural follow-up is adding `audio` to the app-shortcuts list (5 shortcuts instead of 4). One-line plugin edit. Defer until the recording UX is validated and we know users actually use it.
- The next slate item after this — #6 inline edit — gives users a way to rename audio captures from inside carnet without opening Obsidian. Together with audio recording, that's the AudioPen UX without the cloud.
