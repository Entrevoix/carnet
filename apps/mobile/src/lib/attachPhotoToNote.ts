// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Attach a photo to a note that is already saved — the VIEW-mode counterpart to
 * useNoteEditSession's insert handlers, which only run inside an open editor.
 *
 * Mirrors enhanceProse.ts's write spine (baseline → slow step → fresh read →
 * guarded overwrite) and its never-throws contract, for the same reason: the
 * user frames a shot for as long as they like, and the note can be edited in
 * Obsidian or resynced by Syncthing during that window. Appending to a snapshot
 * the caller loaded earlier would silently revert those edits (#133's defect
 * class), so nothing here trusts a caller-supplied body.
 */

import { writeCapturedVaultImage } from "./vaultImageInsert";
import { getModificationTime, readNote, updateNoteIfUnchanged } from "./writer";

export type AttachPhotoOutcome =
  | { kind: "attached"; rel: string; nextBody: string }
  | { kind: "failed"; reason: string };

/**
 * Write `base64` into the vault's `Photos/` and append its embed to the note at
 * `filepath`. Never throws — every failure returns a `failed` reason and leaves
 * the note on disk exactly as it was.
 *
 * A refused write can leave the image file orphaned in `Photos/`. That is the
 * same accepted trade the existing insert handlers make: an unreferenced file
 * is recoverable from the vault, a clobbered note is not.
 */
export async function attachPhotoToNote(input: {
  filepath: string;
  base64: string;
  mime: string;
  /** Original filename when the image came from the library; camera shots have none. */
  basename?: string;
}): Promise<AttachPhotoOutcome> {
  try {
    const baseline = await getModificationTime(input.filepath);
    const { rel } = await writeCapturedVaultImage(
      input.base64,
      input.mime,
      input.basename,
    );

    // CURRENT content, deliberately re-read after the write rather than taken
    // from the caller.
    const source = await readNote(input.filepath);
    const nextBody = `${source.trimEnd()}\n\n![](${rel})\n`;

    const written = await updateNoteIfUnchanged(input.filepath, nextBody, baseline);
    if (!written.ok) {
      return {
        kind: "failed",
        reason:
          "The note changed on disk while the camera was open — your version was kept, the photo was not attached.",
      };
    }
    return { kind: "attached", rel, nextBody };
  } catch (e: unknown) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
