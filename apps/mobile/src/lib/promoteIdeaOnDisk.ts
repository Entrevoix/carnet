/**
 * Guarded on-disk status promotion for an already-saved Idea (extracted from
 * CaptureScreen's `promote`).
 *
 * When the user re-classifies an Idea whose file is already written, the note
 * on disk must be updated too — but guarded by an mtime check so a workstation
 * edit synced in between our read and write is kept rather than clobbered
 * (closes the promote-idea race, TODO.md).
 *
 * Prefers a surgical frontmatter rewrite of the file's CURRENT content (so any
 * synced body edits survive the status bump); falls back to writing the freshly
 * enriched markdown only when the file can't be read. Either way the write is
 * routed through `updateNoteIfUnchanged`, so a mid-flight change reports a
 * conflict instead of overwriting the user's version.
 *
 * React-free so the conflict logic is unit-testable without a renderer.
 */

import {
  getModificationTime,
  readNote,
  rewriteFrontmatterField,
  updateNoteIfUnchanged,
} from "./writer";
import type { IdeaStatus } from "@carnet/shared";

/**
 * Rewrite the on-disk note's `status` to `next`, guarded by an mtime check.
 * Returns `{ conflict: true }` when the file changed under us (the write was
 * skipped and the user's version was kept).
 */
export async function promoteIdeaOnDisk(
  filepath: string,
  next: IdeaStatus,
  fallbackMarkdown: string,
): Promise<{ conflict: boolean }> {
  const baseline = await getModificationTime(filepath);
  try {
    const existing = await readNote(filepath);
    const patched = rewriteFrontmatterField(existing, "status", next);
    const res = await updateNoteIfUnchanged(filepath, patched, baseline);
    return { conflict: !res.ok };
  } catch {
    const res = await updateNoteIfUnchanged(filepath, fallbackMarkdown, baseline);
    return { conflict: !res.ok };
  }
}
