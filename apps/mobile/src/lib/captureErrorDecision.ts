/**
 * Capture-error classification (extracted from CaptureScreen).
 *
 * When an enrichment call fails, the screen must decide between three
 * user-facing outcomes without re-implementing the branching inline:
 *   - notConfigured: the OmniRoute URL is blank — a configuration problem, not
 *     an offline blip. Queuing it would "succeed" silently and retry forever
 *     against a nonexistent endpoint, so the screen surfaces it and keeps the
 *     text for a resend.
 *   - permanent: a 4xx from OmniRoute (auth, bad model, malformed input). No
 *     retry helps, so surface the real message and keep the text.
 *   - transient: network / timeout / 5xx — safe to enqueue for a later drain.
 *
 * Pure and React-free so the classification is unit-testable without a renderer.
 */

import { isNotConfiguredError, isPermanentError } from "./dispatcher";

/** Copy shown when the OmniRoute URL is unset — a config error, not offline. */
export const OMNIROUTE_NOT_CONFIGURED_MESSAGE =
  "OmniRoute URL not configured — set it in Settings.";

/**
 * The classified outcome of a failed capture. `notConfigured` and `permanent`
 * both carry the message the screen should surface (and both keep the user's
 * text); `transient` tells the screen to enqueue for a later drain.
 */
export type CaptureErrorDecision =
  | { kind: "notConfigured"; message: string }
  | { kind: "permanent"; message: string }
  | { kind: "transient" };

/** Classify a capture failure into the outcome the screen should act on. */
export function classifyCaptureError(e: unknown): CaptureErrorDecision {
  if (isNotConfiguredError(e)) {
    return { kind: "notConfigured", message: OMNIROUTE_NOT_CONFIGURED_MESSAGE };
  }
  if (isPermanentError(e)) {
    return { kind: "permanent", message: e instanceof Error ? e.message : String(e) };
  }
  return { kind: "transient" };
}
