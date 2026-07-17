/**
 * Syncthing conflict-copy detection (PURE — no filesystem access).
 *
 * When Syncthing can't merge concurrent edits it keeps both versions, writing
 * the loser as `<stem>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<DEVICE>.<ext>`
 * next to the original. Before this module those copies were invisible to the
 * app AND indexed as regular notes — they appeared in Search, inflated tag
 * counts, and could be opened as if canonical (2026-07-17 plan:
 * .claude/PRPs/plans/sync-conflict-visibility.plan.md).
 *
 * writer.listNoteFiles filters on {@link isSyncConflictName} (its one
 * import from here — keep this module pure so that stays cycle-free);
 * writer.listSyncConflictFiles enumerates the copies; {@link pairConflicts}
 * shapes them for the Home banner's review dialog.
 */

import type { NoteFileRef } from "./writer";

/**
 * Matches Syncthing's conflict marker in a filename: `.sync-conflict-` +
 * date + time + device-id, immediately before the final extension (or at the
 * very end for extensionless files). The full timestamp shape is required so
 * a legitimate filename that merely CONTAINS "sync-conflict" isn't flagged;
 * the device-id length is left open (Syncthing emits 7 chars today, but that
 * is not contractual).
 */
export const SYNC_CONFLICT_RE =
  /\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9]+(?=\.[^.]*$|$)/;

/** True when a filename is a Syncthing conflict copy. */
export function isSyncConflictName(name: string): boolean {
  return SYNC_CONFLICT_RE.test(name);
}

/** The canonical filename a conflict copy shadows —
 * `note.sync-conflict-20260716-093012-ABC123.md` → `note.md`.
 * Returns the input unchanged when it carries no conflict marker. */
export function conflictOriginalName(name: string): string {
  return name.replace(SYNC_CONFLICT_RE, "");
}

/** A conflict copy joined to its canonical note (when it still exists). */
export interface ConflictPair {
  /** The `*.sync-conflict-*` copy. */
  conflict: NoteFileRef;
  /** The filename the copy shadows (always derivable). */
  originalName: string;
  /** The canonical note, or null when it was deleted/renamed after the
   * conflict was written — the copy is then the only surviving version. */
  original: NoteFileRef | null;
}

/**
 * Join conflict copies to their originals by (subdir, derived name). Pure so
 * the matching rules are unit-testable without a vault; callers supply the
 * two listings (writer.listSyncConflictFiles / writer.listNoteFiles).
 */
export function pairConflicts(
  conflicts: readonly NoteFileRef[],
  notes: readonly NoteFileRef[],
): ConflictPair[] {
  const byKey = new Map<string, NoteFileRef>();
  for (const note of notes) {
    byKey.set(`${note.subdir}/${note.name}`, note);
  }
  return conflicts.map((conflict) => {
    const originalName = conflictOriginalName(conflict.name);
    return {
      conflict,
      originalName,
      original: byKey.get(`${conflict.subdir}/${originalName}`) ?? null,
    };
  });
}
