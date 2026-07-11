import { describe, expect, it } from "vitest";
import { describeSttError, isFailoverEligibleCode } from "./sttErrorMessage";

describe("describeSttError", () => {
  it("translates a known numeric code, unaffected by the string field", () => {
    expect(describeSttError(3, "audio-capture", "raw")).toBe(
      "Audio recording error — try again (3)",
    );
  });

  // Regression: expo-speech-recognition's own type docs say `code` can be -1
  // "when native code is not available" — before this fix, that meant the
  // numeric map missed and the raw untranslated event text ("audio-capture:
  // ... (code -1)") leaked straight into the "Voice Input" error sheet.
  it("falls back to the string error enum when the numeric code is -1 (native code unavailable)", () => {
    const raw = "audio-capture (code -1)";
    expect(describeSttError(-1, "audio-capture", raw)).toBe(
      "Audio recording error — check nothing else is using the microphone, then try again (audio-capture)",
    );
  });

  it("falls back to the string enum for every documented ExpoSpeechRecognitionErrorCode when the numeric code misses", () => {
    const codes = [
      "aborted",
      "audio-capture",
      "interrupted",
      "bad-grammar",
      "language-not-supported",
      "network",
      "no-speech",
      "not-allowed",
      "service-not-allowed",
      "busy",
      "client",
      "speech-timeout",
      "unknown",
    ];
    for (const code of codes) {
      const result = describeSttError(-1, code, `${code} (code -1)`);
      expect(result).not.toBe(`${code} (code -1)`);
      expect(result).toContain(`(${code})`);
    }
  });

  it("falls back to the raw event text when neither the code nor the string enum is recognized", () => {
    expect(describeSttError(999, "some-future-error-code", "raw fallback text")).toBe(
      "raw fallback text",
    );
  });

  it("falls back to a generic message when raw is empty and nothing matches", () => {
    expect(describeSttError(999, "totally-unknown", "")).toBe("Speech error 999");
  });
});

describe("isFailoverEligibleCode", () => {
  // Regression: expo-speech-recognition's native start() catch-all reports
  // EVERY recognizer-creation exception — including "No service found for
  // package <pinned pkg>" on a device that doesn't ship it — as code -1.
  // Before this fix, -1 wasn't failover-eligible, so a genuinely-absent
  // pinned recognizer was never marked failed and got re-selected on every
  // retry: the same dead-end error, forever.
  it("treats -1 (native catch-all / no code available) as failover-eligible", () => {
    expect(isFailoverEligibleCode(-1)).toBe(true);
  });

  it("treats the documented Android SpeechRecognizer failover codes as eligible", () => {
    for (const code of [5, 9, 11, 12, 13]) {
      expect(isFailoverEligibleCode(code)).toBe(true);
    }
  });

  it("does not treat code 7 (no-match/silence) as failover-eligible — handled as a silent same-recognizer restart instead", () => {
    expect(isFailoverEligibleCode(7)).toBe(false);
  });

  it("does not treat successful/benign codes as failover-eligible", () => {
    for (const code of [0, 1, 2, 3, 4, 6, 8]) {
      expect(isFailoverEligibleCode(code)).toBe(false);
    }
  });
});
