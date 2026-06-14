// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Orchestrates pushing a note's local attachments to Karakeep as assets and
// attaching each to the note's text bookmark. Kept OUT of the karakeep network
// client (which stays writer/vault-free) because resolving a note's `../Subdir/
// file` links to storage URIs needs the writer layer.

import { listPairedBinaries, resolvePairedUri } from "./writer";
import { attachAssetToBookmark, uploadAsset } from "./karakeep";

/**
 * Upload every image/file attachment referenced by `noteBody` and attach it to
 * the given bookmark.
 *
 * - **Audio is skipped** — Karakeep isn't an audio archive, and carnet plays
 *   audio in its own dedicated player.
 * - **Broken links are skipped silently** — a `../Photos/x` whose file was moved
 *   or renamed externally resolves to null and is passed over.
 * - **Stops at the first upload/attach failure** rather than hammering a dead
 *   host once per file, returning that error message.
 *
 * Returns `null` on success (including the no-attachments case), or the first
 * error message — the caller surfaces it WITHOUT losing the already-saved
 * bookmark. This never throws: a per-file resolve/upload/attach error is caught
 * and returned, so the export flow can always finish stamping the bookmark id.
 */
export async function pushNoteAttachments(
  bookmarkId: string,
  noteBody: string,
): Promise<string | null> {
  const links = listPairedBinaries(noteBody).filter((b) => b.subdir !== "Audio");
  for (const link of links) {
    try {
      const resolved = await resolvePairedUri(link.subdir, link.filename);
      if (!resolved) continue; // file moved/renamed externally — skip
      const { assetId } = await uploadAsset({
        uri: resolved.uri,
        mime: resolved.mime,
        filename: link.filename,
      });
      await attachAssetToBookmark(bookmarkId, assetId);
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}
