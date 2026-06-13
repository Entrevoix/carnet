# Plan: STT first-tap-does-nothing bug

> ✅ SHIPPED (#25 95d6138). Archived.

## Summary
Investigate why the first mic tap on a cold-launched app appears to do nothing — the voice button doesn't start recording until the user taps it a second time. Likely cause: the no-saved-pkg branch triggers detection on the first tap, which shows a brief "Scanning N speech services…" toast but doesn't visibly engage the mic. Captured logs will confirm. This plan is investigation-first (Phase A) then fix-with-regression-test (Phase B).

## User Story
As a carnet user,
I want the first tap on the mic button (after a fresh app launch) to start recording immediately,
So that I don't lose a beat on the thing I was about to say.

## Problem → Solution
**Current:** Cold launch → enter Journal/Idea/Person → tap mic once → nothing happens → tap again → mic engages.
**Desired:** First tap engages mic immediately; if a detection step is genuinely needed, it happens transparently without requiring a second tap.

## Metadata
- **Complexity:** Small (likely a 5-20 line change once root cause is confirmed)
- **Source PRD:** N/A
- **PRD Phase:** N/A
- **Estimated Files:** 1-2 modified + 1 test

---

## UX Design
Internal change — no visual UX transformation. Just removing a footgun.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| First mic tap after cold launch | Silent no-op (or invisible scan) | Mic engages, pulse animates, audio starts recording | Same behavior as second tap today |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/voice/VoiceButton.tsx` | the `handleToggle` (~lines 1001-1050) + `startOnDevice` (~877-908) + `startRecognizerRef` (~508-556) | The whole first-tap state machine |
| P0 | `apps/mobile/src/voice/VoiceButton.tsx` | `triggerDetectionRef` (~559-606) | The detection branch that fires when no saved pkg exists |
| P0 | `apps/mobile/src/voice/VoiceButton.tsx` | `DEFAULT_RECOGNIZER_PKGS` const + `pressActiveRef` flow | Determines whether detection is even reached |
| P1 | `apps/mobile/src/screens/CaptureScreen.tsx` | the journal/idea/person mode rendering | Where VoiceButton is mounted; confirms there's no wrapper interfering |
| P1 | `~/.gstack/sessions` or RKStorage `stt_recognizer_pkg` key | Whether the pkg is persisted between sessions | Confirms whether "first tap" really finds no saved pkg |

---

## Patterns to Mirror

### LOGCAT_CAPTURE
```bash
# SOURCE: process used during v0.2 debugging
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb logcat -c
# Now interact on the phone — single tap the mic from cold launch
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb logcat -d --pid=$(adb shell pidof us.beary.carnet) -t 500 \
  | grep -iE "ExpoSpeechService|ReactNativeJS|VoiceButton|start\.|audiostart|speechstart|error|nomatch"
```

### EVENT_BUFFER_DUMP
```ts
// SOURCE: apps/mobile/src/voice/VoiceButton.tsx — eventBufferRef + collectDiagnostics
// The component already records a ring buffer of recognizer events.
// In dev, expose the buffer in the on-screen error sheet via the
// "Copy diagnostics" action button — provides the timeline of:
//   start.request → start → audiostart → speechstart → result → end
// Compare first-tap timeline vs second-tap timeline.
```

### RACE_GUARD_PATTERN (existing pattern in VoiceButton)
```ts
// SOURCE: apps/mobile/src/voice/VoiceButton.tsx startOnDevice
const granted = await requestRecordAudio();
if (!pressActiveRef.current) return;  // released-during-load guard
// ... later ...
if (!pressActiveRef.current && activeEngineRef.current === 'ondevice') return;
```

---

## Phase A — Investigation (do this BEFORE writing any fix)

### A1. Reproduce on a cold launch
- **ACTION:** Force-stop carnet (`adb shell am force-stop us.beary.carnet`). Clear logcat. Launch app fresh. Navigate to Journal. Tap mic ONCE. Observe.
- **CAPTURE:** Logcat tail of the JS bridge + ExpoSpeechService events for the 5 seconds following the tap.
- **DOCUMENT:** What's the last event in the buffer? Did `start.request` fire? Did `audiostart` follow? Was there an error?

### A2. Inspect persisted state
- **ACTION:** Pull `databases/RKStorage` from the app sandbox; query `stt_recognizer_pkg`, `stt_recognizer_label`, `stt_engine`.
- **CAPTURE:** Are these keys present after a fresh install? After the first session?
- **DECISION:** If `stt_recognizer_pkg` is null on first launch → first tap definitely enters the no-saved-pkg branch and `startRecognizerRef` calls into `DEFAULT_RECOGNIZER_PKGS[0]`. If both DEFAULT_RECOGNIZER_PKGS pkgs fail with code 5/7/9, `triggerDetectionRef` fires and shows "Scanning…" — that's the perceived no-op.

### A3. Decide root cause (write it down before fixing)
Likely candidates, ordered by probability:
1. **Most likely:** First tap finds no saved pkg → `startRecognizerRef(null)` → tries `com.google.android.tts` → recognizer briefly errors (code 5 = no service mid-bind) → error handler sets `pressActiveRef = false` → second tap finds the now-cleared state and works. The "Scanning…" toast is too transient for the user to see.
2. **Possible:** Permission dialog flashes and dismisses on first tap (already-granted from CardScannerModal but a phantom prompt happens once after install) → `pressActiveRef` reset by the dialog's lifecycle hook → second tap works.
3. **Less likely:** Race between `requestRecordAudio` and `startRecognizerRef` such that the permission resolves AFTER `pressActiveRef` is cleared by a stale `end` event from a previous (null) recognizer session.

Write a one-paragraph root cause note in the eventual commit message.

---

## Phase B — Fix

### Task B1: Apply the targeted fix
Based on the root cause, ONE of:

**If root cause #1 (no-saved-pkg branch):**
- **ACTION:** After detection completes on first tap, immediately auto-start the recognizer with the winning pkg INSTEAD of bouncing back to the input state. The code already does this when `realHits.length === 1` (line ~585) and ~similar at the multi-hit picker — but the silent-fail path on first tap may exit without doing so.
- **IMPLEMENT:** Audit the post-detection path; ensure `pressActiveRef.current` stays true through the detection + auto-start sequence. If the user released during detection, then release; otherwise continue.
- **MIRROR:** `RACE_GUARD_PATTERN`.

**If root cause #2 (permission dialog race):**
- **ACTION:** Move the permission request earlier — e.g., on screen mount in `CaptureScreen` for the journal mode, OR on mounting `VoiceButton` itself via `useEffect`. So by the time the user taps, permission is settled.
- **IMPLEMENT:** Add a `useEffect(() => { ExpoSpeechRecognitionModule.getPermissionsAsync().then(... requestPermissionsAsync if needed ...); }, [])` to VoiceButton.
- **GOTCHA:** Don't request permission for users who'll never use voice — gate on whether VoiceButton is actually rendered. CaptureScreen always renders it in journal/person modes already, so this is fine.

**If root cause #3 (race):**
- **ACTION:** Add an additional `pressActiveRef.current` check after permission resolves, before launching the recognizer.
- **IMPLEMENT:** ~3 line guard.

### Task B2: Add a regression test (where possible)
- **ACTION:** Unit-testing the camera/STT flow is hard without RN Testing Library. But the `triggerDetectionRef` → `realHits` decision logic IS pure and testable.
- **IMPLEMENT:** Extract the post-detection routing into a pure helper:
  ```ts
  function decidePostDetectionAction(hits: RecognizerOption[]): "show-no-service" | "auto-start-single" | "show-picker";
  ```
  Test the three branches. Doesn't directly test the bug but locks in the routing logic for future changes.
- **MIRROR:** Existing test patterns in queue.test.ts / omniroute.test.ts.

### Task B3: On-device validation
- **ACTION:** Same reproduction steps as A1. First tap should engage mic immediately (or show a single, visible "Scanning…" toast followed by automatic mic engagement, no second tap required).
- **VALIDATE:** Capture logcat showing `start.request → start → audiostart` within ~1s of the first tap.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/voice/VoiceButton.tsx` | UPDATE | The fix — likely 5-20 lines in either `startOnDevice`, `triggerDetectionRef`, or `handleToggle`. |
| `apps/mobile/src/voice/VoiceButton.helpers.ts` | CREATE (optional) | If we extract the post-detection helper for unit testing. |
| `apps/mobile/src/voice/VoiceButton.test.ts` | CREATE (optional) | Tests for the extracted helper. |

## NOT Building
- **A whole new STT engine.** Stay with `expo-speech-recognition`.
- **Defaulting to Whisper.** That's a separate user choice; first-tap should work for the on-device path which is the default.
- **Pre-warming the recognizer on app launch.** Adds complexity; the right fix is the tap path, not background warming.
- **A user-facing toggle to "Always use Google".** The detection flow exists for a reason — multi-recognizer devices.

---

## Validation Commands

```bash
# After the fix:
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test

# Cold launch reproduction:
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb shell am force-stop us.beary.carnet
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb logcat -c
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb shell am start -n us.beary.carnet/.MainActivity
# Now tap mic once on the phone, wait 3s, then:
PATH="/home/user/Android/Sdk/platform-tools:$PATH" adb logcat -d --pid=$(adb shell pidof us.beary.carnet) \
  | grep -iE "ExpoSpeechService|ReactNativeJS|VoiceButton|start\.|audiostart|speechstart"
# EXPECT: start.request → start → audiostart within ~1 second of the tap
```

### Manual Validation
- [ ] Force-stop carnet
- [ ] Launch fresh
- [ ] Journal mode → tap mic ONCE → mic engages, pulse animates, voice transcribes
- [ ] Background app, return, tap mic — still works (warm state)
- [ ] Settings → clear `stt_recognizer_pkg` via adb sqlite3 → force-stop → cold launch → first tap still works (no-saved-pkg branch)

---

## Acceptance Criteria
- [ ] Root cause confirmed via logcat evidence (documented in commit message)
- [ ] First tap on a cold launch engages mic within 1 second
- [ ] No regression on second / subsequent taps
- [ ] No regression on the detection flow when multiple recognizers are installed
- [ ] If helper extracted: pure-function tests for post-detection routing pass

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bug is intermittent and not reproducible on demand | Medium | Can't verify the fix | Reproduce 5 cold launches in a row; if 3+ exhibit the no-op, the bug is real |
| Root cause is in expo-speech-recognition itself, not our code | Low | Can't fix without forking | Workaround at our level: pre-warm recognizer via `getSupportedLocales` on mount before the user taps |
| "Fixing" first-tap breaks the multi-recognizer picker flow | Medium | Different bug | Phase B's audit explicitly checks that `realHits.length > 1` still shows the picker; test on a device with multiple STT services installed |
| Permission prompt path differs between Android 13/14/15/16 | Medium | Fix works on dev device, fails on others | Test on Pixel 9 Pro Fold (current) + at least one older Android target if available |

## Notes
- The investigation must come first. Don't write a fix until logcat confirms which branch is the no-op. A "fix" applied to the wrong branch silently regresses something else.
- This is a quality-of-life bug, not a data-loss bug. Low blast radius if the fix is wrong; high user-trust impact if the fix lands cleanly.
