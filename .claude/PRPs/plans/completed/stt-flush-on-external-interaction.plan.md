# Plan: Gracefully stop + flush STT when tapping attach controls mid-dictation

> ✅ SHIPPED (#32 3bc4959). Only remaining is device-side (download the on-device speech model + speak-test) — no code left; tracked in project memory. Archived.

## Summary
While voice dictation (STT) is recording in the Idea/Journal capture flow, tapping the **Image**/**File** attach buttons (or a pending-attachment chip's ✕) interrupts the recognizer and the in-progress transcript is **lost** — never committed to the text field. This adds an imperative `stopAndFlush()` to `VoiceButton` that commits whatever has been transcribed so far (treats the live partial as final), and calls it from CaptureScreen's attach handlers *before* the picker opens, so the partial is saved instead of stranded.

## User Story
As a carnet user dictating an idea, I want to tap "Attach image/file" (or remove a staged chip) without losing what I've already spoken — STT should gracefully stop and save the transcript so far — so that adding an attachment mid-thought doesn't throw away my words.

## Problem → Solution
**Current:** `VoiceButton` only commits on `isFinal`. The single final commit happens in the `end` listener's *user-stopped* branch (VoiceButton.tsx:813-826). Tapping an attach button calls `pickAttachment()` → `DocumentPicker.getDocumentAsync()` opens a separate Activity → the app backgrounds → the recognizer fires `end` (or `error`) while `pressActiveRef` is still `true`, so VoiceButton takes the **auto-restart** path (813-811): it folds the segment into `sessionTextRef`, resets, and tries to restart in 500ms — but the app is backgrounded and nothing is ever emitted as `isFinal`. CaptureScreen's `onTranscript` ignores non-final updates, so the partial never lands in `text`.
**Desired:** Tapping an attach control (Image/File button, or a chip ✕) first asks `VoiceButton` to **stop and flush** — synchronously commit the composed transcript (`sessionTextRef` + `composeText()`) via `onTranscript(text, true)`, release the mic with `ExpoSpeechRecognitionModule.stop()`, and suppress the `end` listener's duplicate flush. Then the attach action proceeds. The spoken text is preserved in the field and the attachment is staged.

## Metadata
- **Complexity**: Medium (2 files; new imperative-handle pattern; mostly on-device verification)
- **Source PRD**: N/A (free-form `/prp-plan` bug report)
- **PRD Phase**: N/A
- **Estimated Files**: 2 source (+ optional 1 test)

---

## UX Design

### Before
```
[⏺ dictating…]  "remind me to email —"
   user taps [📎 File]
        ↓ picker opens, app backgrounds
   recognizer ends → auto-restart path → partial stranded in sessionTextRef
        ↓ user picks a file, returns
   text field: (empty)         ← "remind me to email" LOST
```

### After
```
[⏺ dictating…]  "remind me to email —"
   user taps [📎 File]
        ↓ stopAndFlush() commits the partial FIRST
   text field: "remind me to email"   ← saved
        ↓ picker opens → user picks → returns
   text field: "remind me to email"  + spec.pdf chip staged
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Tap Image/File while dictating | STT cut off, partial lost | STT stops, partial appended to the field, then picker opens | The headline fix |
| Tap chip ✕ while dictating | STT may be interrupted, partial lost | STT stops + partial saved, then chip removed | Same mechanism |
| Mic icon after the above | stuck "listening" or silently dead | returns to idle (`⏺`) | `stopAndFlush` calls `stopListening()` |
| Tap Send while dictating | partial not in `text` yet (out of scope here) | unchanged this PR — see NOT Building | Trickier (state timing); follow-up |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/voice/VoiceButton.tsx` | 237-244, 289-308, 462-494, 786-827, 999-1050 | Props/handle, session refs, `composeText`/`stopListening`, the `end`-listener flush (the template), and `handleToggle` stop path (the template for an external stop) |
| P0 | `src/screens/CaptureScreen.tsx` | (current) `addAttachment`/`removeAttachment`, `submit`, `ModeInput`, `PersonInput` | Where the attach handlers + VoiceButton instances live; thread the ref |
| P1 | `src/voice/VoiceButton.tsx` | 608-633 | `result` listener — shows the live partial is already emitted as `onTranscript(display, false)` and the refs that hold it |
| P1 | `src/voice/VoiceButton.tsx` | 910-919, 954-997 | `stopOnDevice` / `finishWhisper` — engine-specific stop the handle must route to |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| expo-speech-recognition results | https://github.com/jamsch/expo-speech-recognition | `interimResults:true` emits `result` events with `isFinal`; `continuous:true` emits several finals. `stop()` ends gracefully and lets the final result flush via `end`; `abort()` cancels WITHOUT a final — so flush uses `stop()`, never `abort()`. |
| React imperative handle | https://react.dev/reference/react/useImperativeHandle | Standard way to expose `stopAndFlush()` from a child to a parent via `forwardRef`. |

---

## Patterns to Mirror

### EXISTING_FLUSH (the user-stopped commit — what stopAndFlush replicates, synchronously)
```ts
// SOURCE: src/voice/VoiceButton.tsx:813-826 (end listener, user-stop branch)
const finalText = sessionTextRef.current
  ? (text ? `${sessionTextRef.current} ${text}` : sessionTextRef.current)
  : text;                                  // text = composeText()
if (finalText) onTranscriptRef.current(finalText, true);
sessionTextRef.current = '';
resetAccumulator();
pressActiveRef.current = false;
activeEngineRef.current = null;
// clear max timer; stopListeningRef.current();
```

### COMPOSE (joins finals + the in-progress interim — captures the partial)
```ts
// SOURCE: src/voice/VoiceButton.tsx:477-482
const composeText = useCallback(() => {
  const finals = finalSegmentsRef.current.join(' ').trim();
  const interim = interimRef.current.trim();
  if (finals && interim) return `${finals} ${interim}`;
  return finals || interim;
}, []);
```

### EXTERNAL_STOP_ROUTING (engine-aware stop — mirror for the handle)
```ts
// SOURCE: src/voice/VoiceButton.tsx:1004-1016 (handleToggle second tap)
if (pressActiveRef.current) {
  pressActiveRef.current = false;
  clearMaxTimer();
  const engine = activeEngineRef.current;
  activeEngineRef.current = null;
  if (engine === 'whisper') void finishWhisper();
  else if (engine === 'ondevice') stopOnDevice();
  return;
}
```

### VOICEBUTTON_USAGE (current consumer — the closures to keep)
```tsx
// SOURCE: src/screens/CaptureScreen.tsx (ModeInput, idea block)
<VoiceButton
  onTranscript={(t, isFinal) => {
    if (isFinal) onTextChange(text ? `${text}\n${t}`.trim() : t);
  }}
/>
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/voice/VoiceButton.tsx` | UPDATE | `forwardRef` + `useImperativeHandle` exposing `stopAndFlush()`; export `VoiceButtonHandle` type; add the synchronous on-device flush + a guard so the `end` listener doesn't double-commit; route whisper to `finishWhisper`. |
| `src/screens/CaptureScreen.tsx` | UPDATE | Create `voiceRef`; thread it through `ModeInput` to the Idea + Journal `VoiceButton`s; call `voiceRef.current?.stopAndFlush()` at the top of `addAttachment` and `removeAttachment`. |
| `src/voice/voiceFlush.test.ts` *(optional)* | CREATE | If the compose/flush is extracted to a tiny pure helper, unit-test it (finals+interim join, empty). Otherwise verification is on-device. |

## NOT Building
- **Flushing STT before Send/submit** — same class of bug but trickier (the flushed text must be read synchronously into `submit()` rather than via async `setText`). Deferred to a follow-up; called out so it isn't silently assumed fixed.
- **Auto-stop on AppState background** — a broader safety net (catches app-switch), but doesn't cover same-screen chip taps and adds its own edge cases (notification shade, etc.). Out of scope; the explicit `stopAndFlush` from the attach handlers covers the reported cases.
- **Person mode** — the attach buttons render only for `mode !== "person"`, so there's no STT-vs-attach conflict there; no change needed.
- **Changing tap-to-toggle semantics or the recognizer/failover logic** — untouched.
- **Whisper partial preview** — whisper has no interim (audio is sent on stop); `stopAndFlush` for whisper just finishes the recording (commits when transcription returns).

---

## Step-by-Step Tasks

### Task 1: Add an imperative `stopAndFlush()` handle to VoiceButton
- **ACTION**: Convert `VoiceButton` to `forwardRef` and expose a `stopAndFlush()` method; export a `VoiceButtonHandle` type.
- **IMPLEMENT**:
  - `export interface VoiceButtonHandle { stopAndFlush: () => void }`.
  - `export const VoiceButton = forwardRef<VoiceButtonHandle, VoiceButtonProps>(function VoiceButton({ onTranscript, disabled }, ref) { … })`.
  - Add a guard ref near the other session refs: `const flushedExternallyRef = useRef(false)`.
  - `useImperativeHandle(ref, () => ({ stopAndFlush }), [stopAndFlush])` where:
    ```ts
    const stopAndFlush = useCallback(() => {
      if (!pressActiveRef.current) return;          // not recording → no-op
      clearMaxTimer();
      const engine = activeEngineRef.current;
      if (engine === 'whisper') {
        // Whisper has no interim; finishing transcribes + commits on return.
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        void finishWhisper();
        return;
      }
      // On-device: commit the composed partial NOW (from JS state) so it can't
      // be stranded by the recognizer's auto-restart when the app backgrounds.
      const text = sessionTextRef.current
        ? (composeText() ? `${sessionTextRef.current} ${composeText()}` : sessionTextRef.current)
        : composeText();
      if (text) onTranscriptRef.current(text, true);
      flushedExternallyRef.current = true;          // suppress the end-listener double-flush
      sessionTextRef.current = '';
      resetAccumulator();
      pressActiveRef.current = false;
      activeEngineRef.current = null;
      stopOnDevice();                               // releases the mic; end will fire
    }, [composeText, finishWhisper, resetAccumulator, clearMaxTimer, stopOnDevice]);
    ```
  - In the `end` listener's **user-stopped** branch (VoiceButton.tsx:813-827), short-circuit when already flushed:
    ```ts
    if (flushedExternallyRef.current) {
      flushedExternallyRef.current = false;
      sessionTextRef.current = '';
      resetAccumulator();
      pressActiveRef.current = false;
      activeEngineRef.current = null;
      stopListeningRef.current();
      return;                                       // do NOT emit isFinal again
    }
    ```
- **MIRROR**: EXISTING_FLUSH (813-826), EXTERNAL_STOP_ROUTING (1004-1016), COMPOSE (477-482).
- **IMPORTS**: add `forwardRef, useImperativeHandle` to the existing `react` import.
- **GOTCHA**: `stopAndFlush` references `finishWhisper`/`stopOnDevice`, which are declared *below* the imperative handle today — reorder so the handle (and its `useImperativeHandle`) is defined AFTER those `useCallback`s, or hoist them. Use `stop()` semantics (graceful) — never `abort()` (discards the final). The synchronous JS commit is deliberate: it avoids a race where the picker Activity suspends JS before the native `end` round-trips.
- **VALIDATE**: `tsc --noEmit` clean; the handle type exports; existing tap-to-toggle still works (manual).

### Task 2: Thread a `voiceRef` from CaptureScreen to the Idea/Journal VoiceButtons
- **ACTION**: Give CaptureScreen a ref to the active VoiceButton so it can stop+flush before attach actions.
- **IMPLEMENT**:
  - In `CaptureScreen`: `const voiceRef = useRef<VoiceButtonHandle>(null)` (import the type).
  - Add a `voiceRef?: React.Ref<VoiceButtonHandle>` prop to `ModeInputProps`; pass `ref={voiceRef}` to the Idea and Journal `VoiceButton`s (only those two — person mode has no attach buttons). Pass `voiceRef` from CaptureScreen into `<ModeInput … voiceRef={voiceRef} />`.
- **MIRROR**: VOICEBUTTON_USAGE; existing ModeInput prop-passing.
- **IMPORTS**: `type VoiceButtonHandle` from `../voice/VoiceButton`.
- **GOTCHA**: only one mode renders at a time, so a single ref is fine. Don't attach it to the PersonInput VoiceButton (harmless if you do, but unnecessary). A forwardRef component accepts `ref` directly.
- **VALIDATE**: `tsc` clean; ref is non-null while the mic is mounted.

### Task 3: Call `stopAndFlush()` before attach interactions
- **ACTION**: Stop + flush STT at the start of the attach handlers so the partial is committed before the picker opens / chip mutates.
- **IMPLEMENT**:
  - `addAttachment`: first line → `voiceRef.current?.stopAndFlush();` then the existing `setError(null)` + `await pickAttachment(...)`.
  - `removeAttachment`: first line → `voiceRef.current?.stopAndFlush();` then the existing `setPending(...)`.
- **MIRROR**: existing handler bodies.
- **GOTCHA**: `stopAndFlush` commits via `onTranscriptRef.current` (always the latest closure, kept fresh by VoiceButton.tsx:350), so the append uses the current `text`. It's a synchronous call — safe to invoke immediately before the async `pickAttachment()`.
- **VALIDATE**: on-device (see Manual).

### Task 4: (Optional) Extract + unit-test the flush composition
- **ACTION**: If desired, lift the "compose finals+interim+sessionText" join into a tiny pure function and test it.
- **IMPLEMENT**: `export function composeFlush(sessionText: string, finals: string[], interim: string): string` returning the same join `stopAndFlush` uses; test finals+interim, sessionText prefix, all-empty → "".
- **MIRROR**: `markdownEdit.test.ts` / `writer.test.ts` pure-helper test style.
- **GOTCHA**: keep VoiceButton using the same helper so the test reflects real behavior.
- **VALIDATE**: `vitest run` green.

---

## Testing Strategy

### Unit Tests
| Test | Input | Expected | Edge? |
|---|---|---|---|
| composeFlush finals+interim (opt) | `("", ["a"], "b")` | `"a b"` | no |
| composeFlush sessionText prefix (opt) | `("pre", ["a"], "")` | `"pre a"` | yes |
| composeFlush empty (opt) | `("", [], "")` | `""` | yes |

(VoiceButton itself is native-heavy and currently untested; the flush logic is the only easily-pure part.)

### Edge Cases Checklist
- [ ] Tap attach button with NO speech yet (empty partial) → no spurious text appended, picker still opens
- [ ] Tap attach mid-utterance (interim only, no final yet) → interim committed
- [ ] Tap attach after several utterances (continuous finals) → all committed in order
- [ ] Whisper engine: tap attach mid-recording → `finishWhisper` runs, commits on return (no double-commit)
- [ ] Not recording → `stopAndFlush` is a no-op
- [ ] Mic icon returns to idle after stopAndFlush
- [ ] No double-commit (end listener guarded by `flushedExternallyRef`)

---

## Validation Commands

### Static Analysis
```bash
cd apps/mobile && npx tsc --noEmit
```
EXPECT: Zero type errors

### Unit Tests
```bash
cd apps/mobile && npx vitest run
```
EXPECT: No regressions (currently 276 passing); +3 if the optional helper test is added

### Build (no new native dep — JS-only change, but STT is native so verify on a real build)
```bash
cd apps/mobile && npm run android:release
```
EXPECT: BUILD SUCCESSFUL (no new native module; release just to run on-device)

### Manual / On-device (Pixel 9 Pro Fold — OmniRoute now configured)
- [ ] Idea → tap mic → speak a few words → tap **File**: the spoken words appear in the field, THEN the picker opens; pick a file → returns with text + chip both present
- [ ] Repeat with **Image**
- [ ] Speak → tap a staged chip's ✕ → text preserved, chip removed, mic idle
- [ ] Speak nothing → tap File → no stray text; picker opens
- [ ] Journal mode: same checks on the transcript field
- [ ] (If whisper configured) same flow commits after transcription returns

---

## Acceptance Criteria
- [ ] Tapping Image/File (or a chip ✕) while dictating commits the in-progress transcript to the field instead of losing it
- [ ] STT stops cleanly (mic returns to idle) and the attachment action still completes
- [ ] No double-commit of the transcript
- [ ] Empty-partial tap appends nothing
- [ ] tsc clean, full vitest green (no regressions), release build succeeds
- [ ] On-device QA passes for Idea + Journal

## Completion Checklist
- [ ] `stopAndFlush` mirrors the existing end-listener flush exactly (same join order)
- [ ] `end` listener guarded against double-flush
- [ ] Whisper path routes to `finishWhisper`, on-device path commits synchronously
- [ ] Ref threaded only where attach buttons exist (Idea/Journal)
- [ ] Uses `stop()` not `abort()`
- [ ] No change to tap-to-toggle, failover, or recognizer detection
- [ ] No scope creep (Send-flush + AppState net explicitly deferred)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Picker Activity suspends JS before the native `end` flush | Med | High (the bug) | Commit the partial SYNCHRONOUSLY from JS in `stopAndFlush` before calling `pickAttachment` — don't rely on the native `end` round-trip |
| Double-commit (stopAndFlush + end listener) | Med | Med | `flushedExternallyRef` guard short-circuits the end-listener user-stop branch |
| Reorder of `finishWhisper`/`stopOnDevice` vs the handle breaks something | Low | Med | Keep them as `useCallback`s declared before `useImperativeHandle`; tsc + manual tap-to-toggle check |
| forwardRef churn affects existing VoiceButton callers | Low | Low | Only CaptureScreen consumes the ref; other usages (PhotoCaptureScreen, ShareReceive) ignore `ref` and keep working |
| Stale `text` closure on append | Low | Med | VoiceButton already keeps `onTranscriptRef.current` fresh every render (VoiceButton.tsx:350) |

## Notes
- The crux: the recognizer already *captures* the partial (`interimRef`/`sessionTextRef`) and even streams it to the parent as a **non-final** `onTranscript(display, false)` — CaptureScreen just ignores non-final updates. The fix doesn't add new transcription; it adds a way to **promote the current partial to final** on an external interaction, exactly as the stop-tap already does, but triggered by the parent and committed synchronously to beat the picker's Activity switch.
- Composes with the merged attachments work (PR #30) — `addAttachment`/`removeAttachment`/`pickAttachment` are the integration points.
- Related prior STT work: the first-tap-eaten-by-keyboard fix (PR #25, `keyboardShouldPersistTaps`) and the Android-16 Soda ambient-model fix (in `startRecognizerRef`).
- Confidence: 8/10 single-pass. The logic is well-scoped and mirrors an existing path; the residual unknown is the exact on-device timing of the picker Activity switch vs the synchronous flush — mitigated by committing from JS state, verified on-device.
