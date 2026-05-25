# Plan: Auto-transcribe audio captures on save (v0.4 S1)

## Summary
New opt-in Settings toggle that automatically runs the Whisper transcription pipeline after every audio capture (in-app recording or share-receive). The saved screen appears immediately as today; transcription runs in the background and inline-updates the note with a `## Transcript` section when it completes. Removes the "tap Transcribe on RecentDetail" step for users who always want transcripts.

## User Story
As a carnet user who records voice memos frequently,
I want carnet to transcribe them automatically when I save,
So that I don't have to tap Transcribe on every recent — searchable text is just there.

## Problem → Solution
**Current:** Recording flow: tap Audio → record → Stop & save → saved screen → Done → tap recent → tap Transcribe → wait. Five taps + the wait before the transcript exists in the vault.

**Desired:** Recording flow with toggle on: tap Audio → record → Stop & save → saved screen (with "Transcribing…" inline indicator) → Done. Three taps. The transcript lands in the note ~5-30s later regardless of whether the user is still on the saved screen.

## Metadata
- **Complexity:** Medium
- **Source PRD:** `.claude/PRPs/prds/v0.4-ai-deepening.prd.md`
- **PRD Phase:** Slate 1 (S1)
- **Estimated Files:** 1 new helper + 4 modified + 1 test
- **Confidence Score:** 9/10 — all primitives exist (transcribeAudio, upsertSection, readPairedBinaryFromNote, updateNote). Pattern mirrors RecentDetail's handleTranscribe exactly, just fired from a different trigger.

---

## UX Design

### Before (today, with auto-transcribe OFF)
```
Recording…                    Saved to vault
[Stop & save]                  Audio/audio-foo.m4a
                               [Done]
                                      │
                                      ▼ (recent appears in list)
                                      │
                                      ▼ user taps recent → taps Transcribe → waits
```

### After (toggle ON)
```
Recording…                    Saved to vault
[Stop & save]                  Audio/audio-foo.m4a
                               ⟳ Transcribing audio…
                               [Done]
                                      │
                                      ▼ ~5-30s later, regardless of where user is:
                                      │   Audio/audio-foo.m4a now has ## Transcript
                                      ▼ recent's body shows the transcript on next open
```

### Interaction Changes
| Touchpoint | Before | After (toggle on) |
|---|---|---|
| Settings → AI section | omniRouteUrl, key, model, transcription model | + Switch "Auto-transcribe audio on save" |
| AudioCaptureScreen saved phase | path + Done | + "Transcribing audio…" inline indicator if in flight, or "Transcript saved" briefly if it completed |
| AudioCaptureScreen saved phase (transcription error) | n/a | "Auto-transcribe failed: {reason}" banner — non-fatal, the audio + stub note are already on disk |
| ShareReceiveScreen audio branch saved phase | path + Done | same inline indicator |
| RecentDetail Transcribe button | always shown for shared-audio | unchanged — user can still manually re-run (e.g. after auto-transcribe failed) |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/omniroute.ts` | `transcribeAudio` body | Existing function. New helper wraps it. |
| P0 | `apps/mobile/src/lib/writer.ts` | `upsertSection`, `readPairedBinaryFromNote`, `updateNote` | All three needed for the helper. Already work end-to-end via PR #18. |
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | `handleTranscribe` body | Reference for the exact transcribe-and-upsert flow — same shape, different trigger. |
| P0 | `apps/mobile/src/screens/AudioCaptureScreen.tsx` | `stopAndSave` end + saved-phase render | Where the hook fires + where the indicator renders. |
| P0 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | audio branch end of `save()` + saved-phase render | Second hook site + indicator. |
| P0 | `apps/mobile/src/lib/settings.ts` | `Settings`, `PersistedSettings`, `DEFAULT_PERSISTED` | Pattern for adding a new boolean field. Mirror what PR #19 did for `persistentNotificationEnabled`. |
| P0 | `apps/mobile/src/screens/SettingsScreen.tsx` | Switch row from PR #19 | Existing Switch pattern with `notificationSection` / `notificationRow` styles. Clone for the new toggle. |
| P1 | `apps/mobile/src/lib/captureNotification.ts` | facade shape | Reference for the "isAvailable + mounted-ref + best-effort" facade pattern used in PR #19. |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Transcribe-and-upsert flow | `RecentDetailScreen.tsx` handleTranscribe | regex `../Audio/([^/\s)]+)` → readPairedBinaryFromNote → transcribeAudio → upsertSection → updateNote |
| Saved-phase render | `AudioCaptureScreen.tsx` `if (phase === "saved")` | Card with path + Done button. Add inline indicator before Done. |
| Inline-loader copy | `RecentDetailScreen.tsx` | `<View style={styles.inlineLoading}><ActivityIndicator /><Text>Transcribing audio…</Text></View>` |
| Settings boolean field | `settings.ts` `persistentNotificationEnabled` | DEFAULT_PERSISTED, readPersisted spread, writePersisted explicit copy, getSettings/saveSettings pass-through |
| Settings UI Switch | `SettingsScreen.tsx` PR #19 row | List.Item with right={() => <Switch>}, custom description, optional HelperText below |
| Best-effort write-on-success | Many places (e.g. recordCapture wrapped in try) | `try { ... } catch (e) { console.warn(...) }` — non-fatal, don't block the screen |
| Mounted ref pattern | `RecentDetailScreen.tsx` PR #20 | `const mountedRef = useRef(true)` + cleanup; check before setState |

---

## Patterns to Mirror

### AUTO_TRANSCRIBE_HELPER (new in omniroute.ts)
```ts
import { readPairedBinaryFromNote, readNote, updateNote, upsertSection } from "./writer";
import { getSettings } from "./settings";

/**
 * Optional post-save hook for audio captures. Reads the paired audio file
 * off disk, transcribes via Whisper, and idempotently inserts a `##
 * Transcript` section back into the note. No-op when:
 *   - autoTranscribeOnSave is off
 *   - the note has no `../Audio/...` link (defensive)
 *   - any step throws (returns the error for caller-side surfacing,
 *     never throws — auto-transcribe is best-effort)
 *
 * Returns null on success, an error reason string on failure. Callers
 * pass the reason to a banner if they want to surface it.
 */
export async function autoTranscribeIfEnabled(
  filepath: string,
): Promise<string | null> {
  try {
    const settings = await getSettings();
    if (!settings.autoTranscribeOnSave) return null;

    const body = await readNote(filepath);
    const linkMatch = body.match(/\.\.\/Audio\/([^/\s)]+)/);
    if (!linkMatch) return "Note has no Audio/ link";
    const filename = linkMatch[1];

    const { base64, mime } = await readPairedBinaryFromNote(body);
    const { text } = await transcribeAudio({ base64, mimeType: mime, filename });
    const next = upsertSection(body, "Transcript", text);
    await updateNote(filepath, next);
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
```
NOTE: this helper imports from `./writer` and `./settings` — both already imported elsewhere in omniroute.ts, so no new dep chain.

### SCREEN_INTEGRATION (AudioCaptureScreen + ShareReceiveScreen)
```tsx
// State:
const [autoTranscribing, setAutoTranscribing] = useState(false);
const [autoTranscribeError, setAutoTranscribeError] = useState<string | null>(null);

// After setSavedFilepath(filepath); setPhase("saved"):
const filepathSnapshot = filepath;  // capture for the async closure
setAutoTranscribing(true);
// Fire-and-forget — the saved screen renders immediately. The indicator
// resolves when the helper returns.
autoTranscribeIfEnabled(filepathSnapshot)
  .then((errMsg) => {
    if (!mountedRef.current) return;
    setAutoTranscribing(false);
    if (errMsg) setAutoTranscribeError(errMsg);
  })
  .catch(() => {
    // Helper never throws by contract, but defend against future changes.
    if (mountedRef.current) setAutoTranscribing(false);
  });

// In saved-phase render:
{autoTranscribing ? (
  <View style={styles.inlineLoading}>
    <ActivityIndicator />
    <Text variant="bodySmall" style={styles.dim}>
      Transcribing audio…
    </Text>
  </View>
) : autoTranscribeError ? (
  <HelperText type="error" visible>
    {`Auto-transcribe failed: ${autoTranscribeError}`}
  </HelperText>
) : null}
```

### SETTINGS_FIELD (additive)
```ts
// settings.ts
export interface Settings {
  // ... existing fields ...
  autoTranscribeOnSave: boolean;
}

interface PersistedSettings {
  // ... existing ...
  autoTranscribeOnSave: boolean;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  // ... existing ...
  autoTranscribeOnSave: false,
};
```
Same shape as `persistentNotificationEnabled` from PR #19. The existing spread `{...DEFAULT_PERSISTED, ...parsed}` in `readPersisted` handles backfill for existing users.

### SETTINGS_UI_SWITCH (clone PR #19's notification row)
```tsx
// SettingsScreen.tsx, place above the existing Capture surfaces section
<View style={styles.notificationSection}>
  <Text variant="titleMedium" style={styles.promptSectionTitle}>
    AI behavior
  </Text>
  <List.Item
    title="Auto-transcribe audio on save"
    description={
      form.autoTranscribeOnSave
        ? "Every audio capture runs through Whisper automatically"
        : "Off — tap Transcribe per note instead"
    }
    left={(p) => <List.Icon {...p} icon="text-recognition" />}
    right={() => (
      <Switch
        value={form.autoTranscribeOnSave}
        onValueChange={(next) =>
          update({ autoTranscribeOnSave: next })
        }
      />
    )}
    style={styles.notificationRow}
  />
  <HelperText type="info" visible>
    Doubles the OmniRoute API spend per audio capture. Skip if you only
    transcribe occasionally.
  </HelperText>
</View>
```
NOTE: simpler than the notification Switch because no permission / native module / reconcile-on-mount logic. Save button (existing) persists the change like other Settings fields.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/omniroute.ts` | UPDATE | Add `autoTranscribeIfEnabled(filepath)` helper |
| `apps/mobile/src/lib/settings.ts` | UPDATE | Add `autoTranscribeOnSave: boolean` field + migration |
| `apps/mobile/src/screens/SettingsScreen.tsx` | UPDATE | New Switch row in "AI behavior" section |
| `apps/mobile/src/screens/AudioCaptureScreen.tsx` | UPDATE | State + inline indicator + fire-and-forget hook at end of stopAndSave |
| `apps/mobile/src/screens/ShareReceiveScreen.tsx` | UPDATE | Same shape in the audio branch of save() |
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATE | Test cases for `autoTranscribeIfEnabled` (off / no-link / happy / transcribe-fail) |

## NOT Building
- **Auto-transcribe for non-audio captures** — image/text/idea/journal/person don't have audio paired binaries. Out of scope by definition.
- **Auto-retry on failure** — if Whisper fails (network, auth, model unavailable), the error banner appears once and that's it. User can tap Transcribe manually from RecentDetail to retry. Building a retry queue here duplicates queue.ts work that's outside this scope.
- **Bulk retroactive auto-transcribe** — toggling the setting on does NOT walk existing audio recents and transcribe them. Only NEW captures get the treatment. Bulk-retro would be a different feature.
- **Per-mode toggle** — there's only one setting, and it covers both AudioCaptureScreen + ShareReceiveScreen audio path. No "auto-transcribe captures but not shares" granularity. Add later if users ask.
- **Progress indicator with elapsed time / cancel button** — the inline spinner is silent (no timer, no cancel). Whisper is ~5-30s; a cancel button would race the API completion and add complexity for marginal benefit.
- **Auto-polish chain (S1 → S2)** — when S2 ships, an opt-in chain "auto-polish after auto-transcribe" is natural. Out of scope here; document as a follow-up in the v0.4 PRD.

---

## Step-by-Step Tasks

### Task 1: Add `autoTranscribeOnSave` field to Settings
- **ACTION:** Edit `apps/mobile/src/lib/settings.ts`.
- **IMPLEMENT:**
  1. Add `autoTranscribeOnSave: boolean;` to `Settings` AND `PersistedSettings`.
  2. Add `autoTranscribeOnSave: false` to `DEFAULT_PERSISTED`.
  3. Pass through in `readPersisted` (auto via spread), `writePersisted` (explicit copy), `getSettings`, `saveSettings`.
  4. Add to the legacy migration return shape (`omniRouteUrl: legacy.omniRouteUrl ?? "", ...`).
- **MIRROR:** Existing pattern from `persistentNotificationEnabled` (PR #19) — same shape, no native side.
- **GOTCHA:**
  - Don't forget the legacy migration. Cascading type errors from omniroute.test.ts fixtures will catch any missed callsite.
- **VALIDATE:** typecheck — cascade errors in SettingsScreen + omniroute.test.ts will surface.

### Task 2: Wire Switch in SettingsScreen
- **ACTION:** Edit `apps/mobile/src/screens/SettingsScreen.tsx`.
- **IMPLEMENT:**
  1. Add `autoTranscribeOnSave: boolean;` to `FormState`.
  2. Pass through in the `useEffect` initializer + `save()`.
  3. New "AI behavior" section above "Capture surfaces", with Switch + HelperText per `SETTINGS_UI_SWITCH`.
  4. Reuse existing `notificationSection` + `notificationRow` styles (or add `aiSection`/`aiRow` if naming sticks).
- **MIRROR:** Existing notification Switch row.
- **GOTCHA:**
  - This Switch flows through the regular Save button — unlike the notification Switch which self-saves. That's fine because there's no native side to keep in sync.
- **VALIDATE:** Manual on-device — flip toggle, hit Save, reopen Settings, confirm persistence.

### Task 3: Add `autoTranscribeIfEnabled(filepath)` to omniroute.ts
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.ts`.
- **IMPLEMENT:** Per `AUTO_TRANSCRIBE_HELPER` above. Place near `transcribeAudio`.
- **IMPORTS:** add `readPairedBinaryFromNote, readNote, updateNote, upsertSection` from `./writer`. `getSettings` is already imported.
- **GOTCHA:**
  - Helper returns string|null instead of throwing. Caller-decides whether to surface to user. Throwing would force every caller to wrap in try.
  - `readNote(filepath)` is needed because the caller passes the filepath; the helper reads the body fresh. Don't make the caller pass the body — race-prone if writeIdea + read aren't strictly sequential.
- **VALIDATE:** unit tests in Task 6.

### Task 4: Fire auto-transcribe from AudioCaptureScreen
- **ACTION:** Edit `apps/mobile/src/screens/AudioCaptureScreen.tsx`.
- **IMPLEMENT:**
  1. Import `autoTranscribeIfEnabled` from `../lib/omniroute`.
  2. Add state: `autoTranscribing`, `autoTranscribeError`.
  3. Add `mountedRef` if not already present (PR #16 may have skipped this — confirm during implementation).
  4. After the existing `setSavedFilepath(filepath); setPhase("saved");`, fire the helper per `SCREEN_INTEGRATION`.
  5. In the saved-phase render: add the inline indicator above the Done button.
- **MIRROR:** `SCREEN_INTEGRATION` above. `RecentDetailScreen`'s transcribing inline-loader for visual parity.
- **GOTCHA:**
  - Fire-and-forget pattern: `void autoTranscribeIfEnabled(...).then(...)` — don't await, the saved screen must render immediately.
  - Capture filepath into a local before the closure to avoid stale-ref issues.
  - mountedRef check: if user taps Done before transcription completes, setState on unmount triggers React warnings. Check before setAutoTranscribing(false).
- **VALIDATE:** Manual on-device with toggle on + off.

### Task 5: Fire auto-transcribe from ShareReceiveScreen audio branch
- **ACTION:** Edit `apps/mobile/src/screens/ShareReceiveScreen.tsx`.
- **IMPLEMENT:** Same as Task 4. Add state, fire helper at the end of the audio branch of `save()` (where the `filepath = mdPath;` line is, after `recordCapture`). Render the indicator in the saved-phase Card.
- **MIRROR:** Task 4 changes.
- **GOTCHA:**
  - ShareReceiveScreen's save() handles 4 kinds (image/audio/file/link). Only the audio branch needs this. Don't fire for the others.
  - The screen has its own `savingRef` and phase machine — don't conflict with the existing save in-flight guard.
- **VALIDATE:** Manual on-device — share an audio file with toggle on, verify the transcript appears.

### Task 6: Tests for `autoTranscribeIfEnabled`
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.test.ts`.
- **IMPLEMENT:** 4-5 cases:
  - Returns null when `autoTranscribeOnSave === false` (no-op, no fetch)
  - Returns null on success (full happy path with mocked readNote/transcribeAudio/upsertSection/updateNote)
  - Returns error string when readNote throws ("Paired binary not found" simulation via missing link)
  - Returns error string when transcribeAudio throws (mock fetch rejects)
  - Returns error string when the note body has no Audio/ link (defensive path)
- **MIRROR:** Existing `transcribeAudio` test patterns — mock fetch + mock getSettings; this adds mocks for `readNote`, `updateNote`, etc. via `vi.mock("./writer")`.
- **GOTCHA:**
  - The settings mock currently returns a fixed shape; new field `autoTranscribeOnSave` defaults to false in DEFAULT_PERSISTED. Test cases that need it true must use `mockResolvedValueOnce` to override.
  - `vi.mock("./writer")` may conflict with the existing module if any other test imports from `./writer` — verify the mock scope is per-file.
- **VALIDATE:** `npm -w @carnet/mobile run test` — 208 existing + 4-5 new = ~213 tests pass.

### Task 7: Validate everything
- **ACTION:** Run typecheck + tests.
- **EXPECT:** 0 type errors. 213 tests pass.

---

## Testing Strategy

### Unit Tests
Per Task 6 — full coverage for the helper. Screen integration is wired through standard React state + the helper; the screen layer is on-device territory like every other screen handler.

### Edge Cases Checklist
- [ ] Toggle OFF → record + save → no transcription fires, no inline indicator
- [ ] Toggle ON → record + save → saved screen appears immediately with "Transcribing audio…" indicator
- [ ] Toggle ON → indicator resolves to nothing (silent) when transcribe succeeds (note has transcript on next view)
- [ ] Toggle ON + Whisper key wrong → "Auto-transcribe failed: ... 401 ..." HelperText (Bearer redacted)
- [ ] Toggle ON + recording >25MB → "Auto-transcribe failed: Audio is XX MB — Whisper caps at 25 MB"
- [ ] Toggle ON + user taps Done before transcribe completes → no setState-on-unmount warning; transcription continues; vault gets the transcript anyway
- [ ] Toggle ON + share an audio file → same flow in ShareReceiveScreen
- [ ] Toggle ON + share a non-audio file → no transcription attempted
- [ ] Existing manual Transcribe button in RecentDetail still works — can re-run after auto-transcribe failed

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 213/213 pass (208 existing + ~5 new).

### Manual on-device
```bash
cd apps/mobile && npm run android
```

---

## Acceptance Criteria
- [ ] `autoTranscribeOnSave: boolean` field exists in Settings; default false
- [ ] Settings has an "AI behavior" section with the toggle + HelperText about API cost
- [ ] AudioCaptureScreen fires the helper after `setPhase("saved")`
- [ ] ShareReceiveScreen audio branch fires the helper after `recordCapture`
- [ ] Inline "Transcribing audio…" indicator on both saved screens
- [ ] Error HelperText surfaces non-fatally; original save is intact
- [ ] 0 type errors; all existing tests still pass; new tests added for the helper

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User flips toggle on, records many audio notes, OmniRoute spend balloons | Medium | Unexpected bill | HelperText explicitly warns about doubled API spend; default off |
| User taps Done before transcribe completes; transcription writes to vault while user is on Home — confusing if they tap recent and don't see transcript yet | Low | Minor UX surprise | RecentDetail re-reads the note on mount; refresh fixes it. Acceptable. |
| Auto-transcribe and manual Transcribe both fire on the same note (race) | Very low | Whichever finishes second wins (idempotent upsert) | upsertSection is idempotent by design; result is fine |
| Whisper transcribes wrong language (English-default on French audio) | Medium | Garbage transcript silently lands in vault | Same as manual Transcribe — out of scope for this PR. S2 polish pass could add language detection |
| The "Auto-transcribe failed" HelperText scrolls off when user taps Done quickly | Low | User never sees the error | Acceptable — manual Transcribe always available from RecentDetail |
| ShareReceiveScreen's audio branch is already long (~50 LOC); auto-transcribe wiring adds more | Medium | File hygiene concern | Keep the fire-and-forget logic to ~10 LOC; matches existing recordCapture try/catch shape |

## Notes
- This PR sets the foundation for v0.4 S2 (transcript polish). When S2 lands, an opt-in "auto-polish after auto-transcribe" toggle is a 5-line addition that chains the two.
- The helper lives in omniroute.ts because that's where transcribeAudio lives and the import chain is already established. Could move to a dedicated `audioCapture.ts` if more audio-specific helpers accumulate.
- mountedRef pattern from PR #20 is the right shape for fire-and-forget setState. AudioCaptureScreen may not have it yet — check during Task 4, add if missing.
