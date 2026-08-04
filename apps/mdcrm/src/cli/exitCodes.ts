import { MarkdownParseError } from "../markdown/parser.js";
import { RecordValidationError } from "../schemas/registry.js";
import { RevisionConflictError } from "../storage/repository.js";

export const EXIT_USAGE = 2;
export const EXIT_VALIDATION = 3;
export const EXIT_CONFLICT = 4;

/** A malformed invocation: unknown command, missing argument, or missing option value. */
export class UsageError extends Error {}

/**
 * Map a thrown value to a process exit code by error *type*.
 *
 * This deliberately never inspects messages. The previous substring test
 * matched "valid" inside unrelated errors such as "invalid credentials", and
 * simultaneously missed real schema rejections, whose message ("must be a
 * supported record type") contains no "valid" at all.
 */
export function exitCodeForError(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof RevisionConflictError) return EXIT_CONFLICT;
  if (error instanceof RecordValidationError || error instanceof MarkdownParseError) return EXIT_VALIDATION;
  return 1;
}
