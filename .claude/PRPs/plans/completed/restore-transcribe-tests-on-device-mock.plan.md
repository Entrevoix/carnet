# Plan: Restore transcribeAudio + autoTranscribeIfEnabled unit tests with on-device mocked

## Summary
PR #22 deleted 17 tests when transcribeAudio swapped from the chat-completion network path to on-device STT via `expo-speech-recognition`. The old tests mocked `fetch`; the new code path dynamic-imports `./audioTranscribeOnDevice` and never touches the network. This PR restores the regression coverage by mocking the on-device wrapper at the module boundary — ~10 tests across the two describe blocks, ~150 LOC.

## User Story
As a contributor refactoring transcribeAudio or autoTranscribeIfEnabled,
I want unit tests that pin the cap check, the happy-path contract, and the never-throws guarantee,
So that a future change can't silently break the audio transcription pipeline.

## Problem → Solution
**Current:** omniroute.test.ts has a 6-line TODO placeholder where the transcribeAudio + autoTranscribeIfEnabled describe blocks used to live (PR #22 ripped them out when the chat-completion implementation was removed). Test count dropped from 214 → 197. Future refactors of the orchestrator code in `transcribeAudio` (cap pre-check, model name plumbing, error wrapping) have no safety net.

**Desired:** Same coverage shape as before, just with the network path swapped for the on-device path. Mock `./audioTranscribeOnDevice` instead of mocking `fetch`. Mock `./writer` (already done) for the autoTranscribeIfEnabled tests. Same per-case fixture pattern, same `vi.mocked(...).mockResolvedValueOnce(...)` shape, same beforeEach reset.

## Metadata
- **Complexity:** Small
- **Source PRD:** N/A — follow-up to PR #22
- **PRD Phase:** N/A
- **Estimated Files:** 1 modified (only omniroute.test.ts)
- **Confidence Score:** 9/10 — straight test work mirroring existing patterns in the same file. No production code change. The only unknowns are vitest's behavior on dynamic imports under vi.mock (covered in mandatory reading).

---

## UX Design
N/A — internal change. Test-only PR. No user-facing impact.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/omniroute.ts` | `transcribeAudio` body (~330-355) | Subject under test. The pre-flight cap check + dynamic import of `./audioTranscribeOnDevice` + return shape `{text, model: "on-device"}` are the contract being pinned. |
| P0 | `apps/mobile/src/lib/omniroute.ts` | `autoTranscribeIfEnabled` body | Second subject. Reads settings.autoTranscribeOnSave, reads body via `readNote`, checks for `../Audio/` link, calls `readPairedBinaryFromNote`, calls `transcribeAudio`, calls `upsertSection`, calls `updateNote`. Never throws — returns null on success or error message on failure. |
| P0 | `apps/mobile/src/lib/omniroute.test.ts` | 1-94 (mocks + imports + beforeEach) | The file we're editing. Existing settings mock + writer mock + fetchMock all stay. The placeholder TODO block (around line 609) is what gets replaced. |
| P0 | `apps/mobile/src/lib/audioTranscribeOnDevice.ts` | exports | What we're mocking. Single named export `transcribeOnDevice(input)` returns `Promise<string>`. |
| P0 | `apps/mobile/src/lib/captureNotification.test.ts` | 1-50 (vi.doMock + vi.resetModules pattern) | Reference for the standard vitest module-mock shape used in this codebase. Note: that file uses `vi.doMock` because each test re-mocks `react-native` with different platform values; for OUR case `vi.mock` (hoisted) is fine because the on-device mock returns whatever we configure per-test via `mockResolvedValueOnce`. |
| P1 | git log of `apps/mobile/src/lib/omniroute.test.ts` | recent | Useful to see what the deleted tests looked like via `git log -p HEAD~3..HEAD apps/mobile/src/lib/omniroute.test.ts` — but the new shape is shaped differently enough that copy-paste isn't useful. |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| vi.mock with dynamic imports | vitest docs | `vi.mock(path)` intercepts at the resolver level, so it works for both static and dynamic imports. The module factory passed to `vi.mock` runs at import time. |
| vi.mocked typed access | vitest docs | `vi.mocked(fn).mockResolvedValueOnce(...)` gives typed access to the mocked function — required when the function under test imports the mock dynamically. |

---

## Patterns to Mirror

### MODULE_MOCK_HOISTED (top of omniroute.test.ts)
```ts
// SOURCE: apps/mobile/src/lib/omniroute.test.ts:24-32 (existing writer mock)
vi.mock("./writer", () => ({
  readNote: vi.fn(),
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(),
  upsertSection: vi.fn(
    (md: string, heading: string, body: string) =>
      `${md}\n\n## ${heading}\n\n${body}\n`,
  ),
}));
```
Hoisted to file top. Single factory per module. New `vi.mock("./audioTranscribeOnDevice", ...)` lands here.

### SETTINGS_FIXTURE_OVERRIDE (per-test setting tweak)
```ts
// SOURCE: omniroute.test.ts:743-754 (HTTPS guard test from PR #22's chat-completion era, now deleted but the pattern stays)
const { getSettings } = await import("./settings");
vi.mocked(getSettings).mockResolvedValueOnce({
  omniRouteUrl: "https://llm.example.com",
  omniRouteApiKey: "test-key",
  omniRouteModel: "gpt-4o-mini",
  omniRouteTranscriptionModel: "gemini/gemini-2.5-flash-lite",
  persistentNotificationEnabled: false,
  autoTranscribeOnSave: true, // ← per-test override
  captureFolderPath: "",
  promptOverrides: {},
});
```
Use to flip `autoTranscribeOnSave` true/false per autoTranscribeIfEnabled test.

### WRITER_FIXTURE_RESET (beforeEach inside describe block)
```ts
// SOURCE: omniroute.test.ts:848-855 (existing autoTranscribeIfEnabled beforeEach pattern from PR #21)
beforeEach(async () => {
  const { readNote, readPairedBinaryFromNote, updateNote } = await import(
    "./writer"
  );
  vi.mocked(readNote).mockReset();
  vi.mocked(readPairedBinaryFromNote).mockReset();
  vi.mocked(updateNote).mockReset();
});
```
Restore this exactly for the autoTranscribeIfEnabled block.

### ON_DEVICE_RESET (new beforeEach for the on-device mock)
```ts
beforeEach(async () => {
  const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
  vi.mocked(transcribeOnDevice).mockReset();
});
```
Add to each describe that depends on the on-device mock.

### OMNIROUTE_ERROR_ASSERTION (existing pattern)
```ts
// SOURCE: omniroute.test.ts:194-205 (existing 401 test for enrichIdea)
try {
  await transcribeAudio({...});
  expect.fail("expected throw");
} catch (e) {
  expect(e).toBeInstanceOf(OmniRouteError);
  expect((e as OmniRouteError).status).toBe(413);
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/omniroute.test.ts` | UPDATE | Add the on-device module mock at top + replace the TODO placeholder with two describe blocks |

## NOT Building
- **Integration test that actually exercises expo-speech-recognition.** Native module can't be loaded under Node + vitest. Manual on-device QA is the integration coverage.
- **Test for the dynamic-import path itself.** Vitest's hoisted vi.mock handles dynamic imports transparently — testing that we use `import()` vs static import would test the implementation detail, not the contract.
- **Restoring the "wraps fetch rejection" or "wraps non-JSON body" tests** — those tested executeChat's behavior through the (now-removed) chat-completion path. executeChat is still tested via the existing enrich* tests. No regression in coverage.
- **Test for the model name** that transcribeAudio returns. It's a hardcoded literal `"on-device"`; asserting that just pins one constant against itself.
- **Test for the HTTPS guard** in transcribeAudio. The on-device path doesn't hit OmniRoute, so there's no HTTPS guard to test in this layer. Guard is still tested via enrichIdea's HTTPS test.

---

## Step-by-Step Tasks

### Task 1: Add the on-device module mock at file top
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.test.ts`.
- **IMPLEMENT:**
  ```ts
  // After the existing vi.mock("./writer", ...) block (around line 32).
  vi.mock("./audioTranscribeOnDevice", () => ({
    transcribeOnDevice: vi.fn(),
  }));
  ```
- **MIRROR:** `MODULE_MOCK_HOISTED`.
- **IMPORTS:** none new — vi is already imported from vitest.
- **GOTCHA:** Hoisting placement matters only for readability; vitest hoists vi.mock calls to the top of the file at compile time regardless. Keep adjacent to the writer mock for grouping.
- **VALIDATE:** typecheck.

### Task 2: Re-import transcribeAudio + autoTranscribeIfEnabled + MAX_TRANSCRIPTION_BYTES
- **ACTION:** Edit the import block at lines ~58-72 of omniroute.test.ts (the one that has enrichIdea, enrichJournal, etc).
- **IMPLEMENT:** Add three imports — they were removed in PR #22's cleanup pass:
  ```ts
  import {
    autoTranscribeIfEnabled,     // ← restore
    enrichIdea,
    // ... existing ...
    MAX_SHARED_IMAGE_BYTES,
    MAX_TRANSCRIPTION_BYTES,     // ← restore
    transcribeAudio,             // ← restore
    withSystemOverride,
  } from "./omniroute";
  ```
- **MIRROR:** Existing import shape (alphabetical-ish).
- **VALIDATE:** typecheck — should remain clean since these are now exercised by Tasks 3/4.

### Task 3: Replace TODO placeholder with `transcribeAudio` describe block
- **ACTION:** Edit `apps/mobile/src/lib/omniroute.test.ts`. Find the TODO placeholder added in PR #22 — search for `// ── transcribeAudio + autoTranscribeIfEnabled ───────────`.
- **IMPLEMENT:** Replace the placeholder block with two describes, transcribeAudio first:
  ```ts
  // ── transcribeAudio ───────────────────────────────────────────────────────────

  describe("transcribeAudio (on-device path)", () => {
    beforeEach(async () => {
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      vi.mocked(transcribeOnDevice).mockReset();
    });

    it("returns the on-device transcript + 'on-device' model on the happy path", async () => {
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

      const out = await transcribeAudio({
        base64: "AAAA",
        mimeType: "audio/mp4",
        filename: "clip.m4a",
      });

      expect(out.text).toBe("hello world");
      expect(out.model).toBe("on-device");
      expect(transcribeOnDevice).toHaveBeenCalledWith({
        base64: "AAAA",
        filename: "clip.m4a",
      });
    });

    it("propagates the on-device error through to the caller", async () => {
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
        new Error("On-device STT error: no-speech — no speech detected"),
      );

      await expect(
        transcribeAudio({
          base64: "AAAA",
          mimeType: "audio/mp4",
          filename: "clip.m4a",
        }),
      ).rejects.toThrow(/no-speech/);
    });

    it("pre-checks the 25 MB cap and throws OmniRouteError 413 before calling the on-device wrapper", async () => {
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      // 40 MB base64 → 30 MB decoded, over the 25 MB cap.
      const oversized = "A".repeat(40 * 1024 * 1024);

      try {
        await transcribeAudio({
          base64: oversized,
          mimeType: "audio/mp4",
          filename: "huge.m4a",
        });
        expect.fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OmniRouteError);
        expect((e as OmniRouteError).status).toBe(413);
        expect((e as OmniRouteError).message).toContain("transcription caps");
      }
      // Pre-flight short-circuits before invoking the wrapper.
      expect(transcribeOnDevice).not.toHaveBeenCalled();
    });

    it("MAX_TRANSCRIPTION_BYTES is 25 MB", () => {
      expect(MAX_TRANSCRIPTION_BYTES).toBe(25 * 1024 * 1024);
    });
  });
  ```
- **MIRROR:** `ON_DEVICE_RESET` for beforeEach, `OMNIROUTE_ERROR_ASSERTION` for the cap test.
- **GOTCHA:**
  - `vi.mocked(transcribeOnDevice)` requires the mock to be HOISTED — confirmed via Task 1's `vi.mock("./audioTranscribeOnDevice")` at top.
  - The cap pre-check string is `"transcription caps at 25 MB"` not `"Whisper caps"` (PR #22 changed the message when removing Whisper).
- **VALIDATE:** Test count rises by 4. `npm test` for the file shows all pass.

### Task 4: Append `autoTranscribeIfEnabled` describe block
- **ACTION:** Continue editing `omniroute.test.ts`. After the transcribeAudio describe from Task 3, add the second describe.
- **IMPLEMENT:**
  ```ts
  // ── autoTranscribeIfEnabled ───────────────────────────────────────────────────

  describe("autoTranscribeIfEnabled", () => {
    const AUDIO_NOTE = `---\nkind: shared-audio\n---\n# Audio\n\n## File\n[clip.m4a](../Audio/clip.m4a)\n\n## Context\n(none)\n`;
    const SETTINGS_TOGGLE_ON = {
      omniRouteUrl: "https://llm.example.com",
      omniRouteApiKey: "test-key",
      omniRouteModel: "gpt-4o-mini",
      omniRouteTranscriptionModel: "gemini/gemini-2.5-flash-lite",
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: true,
      captureFolderPath: "",
      promptOverrides: {},
    };

    beforeEach(async () => {
      const { readNote, readPairedBinaryFromNote, updateNote } = await import(
        "./writer"
      );
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      vi.mocked(readNote).mockReset();
      vi.mocked(readPairedBinaryFromNote).mockReset();
      vi.mocked(updateNote).mockReset();
      vi.mocked(transcribeOnDevice).mockReset();
    });

    it("no-ops (returns null) when autoTranscribeOnSave is false", async () => {
      // Default global mock has it false — no per-test override needed.
      const { readNote } = await import("./writer");
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
      const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
      expect(result).toBeNull();
      // Short-circuits before reading the note OR hitting the recognizer.
      expect(readNote).not.toHaveBeenCalled();
      expect(transcribeOnDevice).not.toHaveBeenCalled();
    });

    it("returns null on the full happy path (read, transcribe, upsert, update)", async () => {
      const { getSettings } = await import("./settings");
      vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
      const { readNote, readPairedBinaryFromNote, updateNote } = await import(
        "./writer"
      );
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

      vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
      vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
        base64: "AAAA",
        mime: "audio/mp4",
      });
      vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

      const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
      expect(result).toBeNull();
      expect(updateNote).toHaveBeenCalledTimes(1);
      const [filepath, newBody] = vi.mocked(updateNote).mock.calls[0];
      expect(filepath).toBe("/vault/Ideas/foo.md");
      expect(newBody).toContain("## Transcript");
      expect(newBody).toContain("hello world");
    });

    it("returns 'Note has no Audio/ link' when body doesn't reference Audio/", async () => {
      const { getSettings } = await import("./settings");
      vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
      const { readNote, readPairedBinaryFromNote } = await import("./writer");
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

      vi.mocked(readNote).mockResolvedValueOnce(
        `---\nkind: idea\n---\n# Plain idea\n\nNo binary link here.\n`,
      );

      const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
      expect(result).toBe("Note has no Audio/ link");
      expect(readPairedBinaryFromNote).not.toHaveBeenCalled();
      expect(transcribeOnDevice).not.toHaveBeenCalled();
    });

    it("returns the readNote error message when reading the note throws", async () => {
      const { getSettings } = await import("./settings");
      vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
      const { readNote } = await import("./writer");
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

      vi.mocked(readNote).mockRejectedValueOnce(
        new Error("ENOENT: no such file"),
      );

      const result = await autoTranscribeIfEnabled("/vault/Ideas/gone.md");
      expect(result).toContain("ENOENT");
      expect(transcribeOnDevice).not.toHaveBeenCalled();
    });

    it("returns the transcribeAudio error message when the on-device recognizer fails", async () => {
      const { getSettings } = await import("./settings");
      vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
      const { readNote, readPairedBinaryFromNote, updateNote } = await import(
        "./writer"
      );
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

      vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
      vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
        base64: "AAAA",
        mime: "audio/mp4",
      });
      vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
        new Error("On-device STT error: no-speech — no speech detected"),
      );

      const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
      expect(result).toContain("no-speech");
      // updateNote MUST NOT run on transcribe failure — the original note
      // stays untouched.
      expect(updateNote).not.toHaveBeenCalled();
    });

    it("never throws — returns an error string even when updateNote rejects", async () => {
      const { getSettings } = await import("./settings");
      vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
      const { readNote, readPairedBinaryFromNote, updateNote } = await import(
        "./writer"
      );
      const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

      vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
      vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
        base64: "AAAA",
        mime: "audio/mp4",
      });
      vi.mocked(transcribeOnDevice).mockResolvedValueOnce("ok");
      vi.mocked(updateNote).mockRejectedValueOnce(
        new Error("SAF tree permission revoked"),
      );

      let returned: string | null | undefined;
      let threw = false;
      try {
        returned = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(returned).toContain("SAF tree permission revoked");
    });
  });
  ```
- **MIRROR:** `WRITER_FIXTURE_RESET` + `ON_DEVICE_RESET` for the combined beforeEach. `SETTINGS_FIXTURE_OVERRIDE` for the toggle-on cases.
- **GOTCHA:**
  - The default global settings mock has `autoTranscribeOnSave: false`. Every test that needs the helper to actually do work must override with `SETTINGS_TOGGLE_ON` via `mockResolvedValueOnce`.
  - The "Note has no Audio/ link" assertion text matches the helper's exact return value — string-compare, not regex.
  - The "never throws" test passes BOTH success-up-to-update AND update-fail: the helper catches all errors at the top-level try.
- **VALIDATE:** 6 new tests pass. Combined with Task 3: +10 tests total.

### Task 5: Final validation
- **ACTION:** Run `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`.
- **EXPECT:** 0 type errors. Test count rises by 10: 197 → 207.

---

## Testing Strategy

### Unit Tests
The plan IS the unit-test work. 10 new tests cover:

| # | Subject | Test | Edge Case? |
|---|---|---|---|
| 1 | transcribeAudio | happy path returns text + model "on-device" | No — contract |
| 2 | transcribeAudio | on-device error propagates to caller | Yes — error path |
| 3 | transcribeAudio | 25 MB cap pre-check throws 413 without calling on-device | Yes — boundary |
| 4 | transcribeAudio | MAX_TRANSCRIPTION_BYTES constant | No — sanity |
| 5 | autoTranscribeIfEnabled | no-op when toggle off | Yes — most common branch |
| 6 | autoTranscribeIfEnabled | happy path → updateNote called with transcript | No — contract |
| 7 | autoTranscribeIfEnabled | "no Audio/ link" branch | Yes — defensive |
| 8 | autoTranscribeIfEnabled | readNote error propagates as string | Yes — error path |
| 9 | autoTranscribeIfEnabled | transcribe error → no updateNote, error string returned | Yes — partial-failure invariant |
| 10 | autoTranscribeIfEnabled | never throws — returns string even on updateNote failure | Yes — top-level contract |

### Edge Cases Checklist
- [x] No-op path (toggle off) — covered by test #5
- [x] Maximum size input (25 MB cap) — covered by test #3
- [x] Transcribe layer error — covered by tests #2 and #9
- [x] Note-not-found / read error — covered by test #8
- [x] Write error post-transcribe — covered by test #10
- [x] Defensive no-link case — covered by test #7
- Not applicable: empty input, invalid types, concurrent access, network failure, permission denied (on-device path has no network; perm denial would surface from expo-speech-recognition which is mocked here)

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 207/207 pass (was 197 + 10 new).

---

## Acceptance Criteria
- [ ] `vi.mock("./audioTranscribeOnDevice", ...)` added at file top
- [ ] `transcribeAudio`, `autoTranscribeIfEnabled`, `MAX_TRANSCRIPTION_BYTES` re-imported
- [ ] 4 transcribeAudio tests + 6 autoTranscribeIfEnabled tests added (10 total)
- [ ] 207/207 tests pass; 0 type errors
- [ ] No production code changed (test-only PR)

## Completion Checklist
- [ ] Tests follow the existing mock + beforeEach + per-test override pattern in the file
- [ ] No hardcoded settings shape — `SETTINGS_TOGGLE_ON` constant deduplicates the fixture
- [ ] mockReset in beforeEach for both writer mocks AND the new on-device mock
- [ ] Per-test `vi.mocked(...)` access uses `await import(...)` to play nicely with vitest's hoisting
- [ ] No assertions on the dynamic-import mechanism itself

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| vi.mock doesn't intercept dynamic imports | Very low | All transcribeAudio tests fail | Documented behavior in vitest; verified pattern in captureNotification.test.ts |
| Default global settings mock changes break SETTINGS_TOGGLE_ON | Low | Spec churn | The constant is colocated with the tests; any drift gets caught immediately |
| Adding 10 new tests slows CI noticeably | Very low | Marginal CI time increase | Each test is sync-mocked, runs in <5ms; total impact ~50ms |
| Future on-device wrapper API changes invalidate the mock signature | Medium long-term | Tests pass against stale mock shape | Type-checked mock factory — TS will catch signature drift the moment audioTranscribeOnDevice.ts changes |

## Notes
- Pure test-restoration PR. No production code touched. Safe to ship at any time.
- The lost-by-PR-22 coverage shape is preserved one-to-one: 4 + 6 = 10 tests vs the original 17, because the 7 deleted tests were about the chat-completion network plumbing (HTTPS guard, fetch rejection wrap, non-JSON body wrap, model fallback string match) that no longer exists at this layer. Those concerns are still covered by enrichIdea's tests where executeChat lives.
- This PR is a natural prerequisite to the AAC decoder PR — once the decoder lands and the on-device path actually works end-to-end, these tests pin the orchestration contract so the wiring around the decoder can't regress silently.
