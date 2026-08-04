import { describe, expect, it } from "vitest";

import { EXIT_CONFLICT, EXIT_USAGE, EXIT_VALIDATION, UsageError, exitCodeForError } from "./exitCodes.js";
import { MarkdownParseError } from "../markdown/parser.js";
import { RecordValidationError } from "../schemas/registry.js";
import { RevisionConflictError } from "../storage/repository.js";

describe("cli exit codes", () => {
  it("maps a usage mistake to the usage code", () => {
    expect(exitCodeForError(new UsageError("Unknown command: nope"))).toBe(EXIT_USAGE);
  });

  it("maps an optimistic-concurrency failure to the conflict code", () => {
    expect(exitCodeForError(new RevisionConflictError("/kb/captures/a.md"))).toBe(EXIT_CONFLICT);
  });

  it("maps schema rejection to the validation code even though its message omits “valid”", () => {
    const error = new RecordValidationError([{ path: "/type", message: "must be a supported record type" }]);
    // The trait the previous substring check silently depended on: this message
    // contains no "valid", so schema rejections used to exit 1 instead of 3.
    expect(error.message).not.toMatch(/valid/);
    expect(exitCodeForError(error)).toBe(EXIT_VALIDATION);
  });

  it("maps unparseable frontmatter to the validation code", () => {
    expect(exitCodeForError(new MarkdownParseError("missing opening YAML frontmatter delimiter"))).toBe(EXIT_VALIDATION);
  });

  it("does not mistake an unrelated error that merely contains “invalid” for a validation failure", () => {
    expect(exitCodeForError(new Error("invalid credentials for remote transport"))).toBe(1);
  });

  it("treats a non-Error throw as a generic failure", () => {
    expect(exitCodeForError("boom")).toBe(1);
  });
});
