// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure recognizer-selection helpers, split out of VoiceButton so they can be
// unit-tested without pulling in React Native / the native speech module.

export interface RecognizerOption {
  pkg: string;
  label: string;
}

// pkg: '' means "let Android pick the default recognizer".
export const SYSTEM_DEFAULT_RECOGNIZER: RecognizerOption = { pkg: '', label: 'System Default' };

// Known-good on-device Google recognizers we pin. Pixel devices have
// settings:secure:voice_recognition_service = null, so an unpinned
// createSpeechRecognizer() throws code 5; and Pixel's on-device SODA is often
// NOT enumerated by getSpeechRecognitionServices(). So these must be injected
// as candidates by detection regardless of what Android enumerates.
export const DEFAULT_RECOGNIZER_PKGS: readonly string[] = [
  'com.google.android.tts',
  'com.google.android.as',
];

export function isPinnedRecognizer(pkg: string): boolean {
  return DEFAULT_RECOGNIZER_PKGS.includes(pkg);
}

/**
 * Decide which recognizer package a `start()` call should actually bind to.
 *
 * Device-hardening rule: we never do a "bare start" (no explicit package),
 * because that hands STT to Android's registered default recognizer — on some
 * devices a third-party app (e.g. an installed assistant) whose
 * RecognitionService is enumerated but cannot serve STT, returning
 * ERROR_CLIENT/INSUFFICIENT_PERMISSIONS. So:
 *  - `null` ("try defaults") and `''` ("system default") both resolve to the
 *    first pinned Google recognizer that hasn't failed this session.
 *  - An explicit, non-empty package is used as-is unless it already failed this
 *    session, in which case it also falls back to a pinned recognizer.
 *  - Returns `null` only when every pinned recognizer has failed — the caller
 *    then runs detection or shows the no-service sheet.
 *
 * @param requested the package the caller asked for (`null`/`''`/explicit pkg)
 * @param hasFailed predicate: has this package already failed this session?
 */
export function resolveEffectivePkg(
  requested: string | null,
  hasFailed: (pkg: string) => boolean,
): string | null {
  const firstAvailablePinned = DEFAULT_RECOGNIZER_PKGS.find((p) => !hasFailed(p)) ?? null;
  if (requested && requested.length > 0) {
    return hasFailed(requested) ? firstAvailablePinned : requested;
  }
  return firstAvailablePinned;
}

/**
 * Build the ordered recognizer candidate list from the packages Android
 * enumerates via getSpeechRecognitionServices().
 *
 * Always includes the pinned DEFAULT_RECOGNIZER_PKGS (even when Android does not
 * enumerate them) and ranks them ABOVE any third-party recognizer, so a rogue
 * third-party RecognitionService — e.g. an installed assistant app that
 * registers a recognizer it cannot actually serve STT with — can never shoulder
 * out Google's working engine. The OS default is ranked next, other third-party
 * recognizers last, and the System Default sentinel is appended as a final
 * fallback.
 */
export function orderRecognizerCandidates(
  services: readonly string[],
  defaultPkg: string,
  labelFor: (pkg: string) => string,
): RecognizerOption[] {
  const merged = Array.from(new Set([...DEFAULT_RECOGNIZER_PKGS, ...services]));
  const rank = (pkg: string): number => {
    const pinnedIdx = DEFAULT_RECOGNIZER_PKGS.indexOf(pkg);
    if (pinnedIdx !== -1) return pinnedIdx; // pinned recognizers first, in listed order
    if (pkg === defaultPkg) return DEFAULT_RECOGNIZER_PKGS.length; // then the OS default
    return DEFAULT_RECOGNIZER_PKGS.length + 1; // then any other third-party recognizer
  };
  const options = merged
    .map((pkg) => ({ pkg, label: labelFor(pkg) }))
    .sort((a, b) => rank(a.pkg) - rank(b.pkg));
  return [...options, SYSTEM_DEFAULT_RECOGNIZER];
}
