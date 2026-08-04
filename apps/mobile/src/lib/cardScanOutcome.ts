/**
 * Card-scan OCR outcome classification.
 *
 * The scanner saves the original image before it ever calls OCR, so an OCR
 * failure is never fatal — but the three failure causes need *different* user
 * actions, and collapsing them into one "OCR unavailable" string tells a user
 * with unconfigured Settings to "scan again", which can never succeed.
 *
 * Specificity comes from the typed signal on the error (`notConfigured` on
 * HttpError, plus a 4xx status), never from matching the message text. See
 * `captureErrorDecision.ts` for the same three-way split on the capture path.
 */
import { isNotConfiguredError, isPermanentError } from "./dispatcher";

export type CardScanOcrOutcome =
  | { kind: "ok" }
  /** Blank provider URL or vision model — Settings must change first. */
  | { kind: "notConfigured"; message: string }
  /** 4xx: bad key, bad model id, rejected image. Retrying cannot help. */
  | { kind: "permanent"; message: string }
  /** Network, timeout, or 5xx. Scanning again is worth a try. */
  | { kind: "transient"; message: string };

export type CardScanOcrFailure = Exclude<CardScanOcrOutcome, { kind: "ok" }>;

export function classifyCardScanOcrError(error: unknown): CardScanOcrFailure {
  // Keep the provider's own wording: it already distinguishes a blank URL from
  // a blank vision model, which a single canonical constant would flatten.
  const message = error instanceof Error ? error.message : String(error);
  if (isNotConfiguredError(error)) return { kind: "notConfigured", message };
  if (isPermanentError(error)) return { kind: "permanent", message };
  return { kind: "transient", message };
}

/** User-facing hint for an outcome, or null when OCR succeeded. */
export function cardScanHint(outcome: CardScanOcrFailure): string;
export function cardScanHint(outcome: CardScanOcrOutcome): string | null;
export function cardScanHint(outcome: CardScanOcrOutcome): string | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "notConfigured":
      return `${outcome.message}. Your card image was saved — scanning again won't help until this is set.`;
    case "permanent":
      return `Card image saved. OCR failed and retrying won't help — ${outcome.message}. Type the details below.`;
    case "transient":
      return `Card image saved. OCR unavailable — ${outcome.message}. Scan again to retry, or type the details below.`;
  }
}
