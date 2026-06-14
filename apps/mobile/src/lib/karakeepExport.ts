// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Orchestrates pushing a note's local attachments to Karakeep as assets and
// attaching each to the note's text bookmark. Kept OUT of the karakeep network
// client (which stays writer/vault-free) because resolving a note's `../Subdir/
// file` links to storage URIs needs the writer layer.

import { listPairedBinaries, resolvePairedUri } from "./writer";
import { attachAssetToBookmark, uploadAsset } from "./karakeep";
import {
  assetKey,
  loadPushedAssetKeys,
  savePushedAssetKeys,
} from "./karakeepAssetSync";

/**
 * Incrementally sync a note's image/file attachments to its Karakeep bookmark:
 * upload + attach only the ones NOT already on this bookmark, skipping the rest.
 *
 * Designed to run on EVERY export (create AND re-export). A per-bookmark sync
 * record ({@link loadPushedAssetKeys}) is consulted so:
 * - already-attached files are skipped → a re-export never duplicates assets;
 * - an attachment added after the first export is picked up on the next one;
 * - an attachment that FAILED earlier is retried (it was never recorded).
 *
 * - **Audio is skipped** — Karakeep isn't an audio archive, and carnet plays
 *   audio in its own dedicated player.
 * - **Broken links are skipped silently** (and NOT recorded) — a `../Photos/x`
 *   whose file was moved/renamed externally resolves to null; if the file later
 *   returns, a subsequent export pushes it.
 * - **Stops at the first upload/attach failure** rather than hammering a dead
 *   host once per file, returning that error message. Every asset that
 *   succeeded BEFORE the failure is already recorded (persisted per success),
 *   so it is not re-pushed on retry.
 *
 * Returns `null` on success (including the no-attachments / nothing-new case),
 * or the first error message — the caller surfaces it WITHOUT losing the
 * already-saved bookmark. This never throws: a per-file resolve/upload/attach
 * error is caught and returned, so the export flow can always finish stamping
 * the bookmark id.
 */
export async function pushNoteAttachments(
  bookmarkId: string,
  noteBody: string,
): Promise<string | null> {
  // Load → mutate in memory → persist. Safe without a lock because exports are
  // single-flighted by the caller (RecentDetailScreen's exportingKarakeepRef),
  // so no second run races this bookmark's record.
  const pushed = await loadPushedAssetKeys(bookmarkId);
  const links = listPairedBinaries(noteBody).filter((b) => b.subdir !== "Audio");
  for (const link of links) {
    const key = assetKey(link.subdir, link.filename);
    if (pushed.has(key)) continue; // already attached to this bookmark — skip
    try {
      const resolved = await resolvePairedUri(link.subdir, link.filename);
      if (!resolved) continue; // file moved/renamed externally — skip (not recorded)
      const { assetId } = await uploadAsset({
        uri: resolved.uri,
        mime: resolved.mime,
        filename: link.filename,
      });
      await attachAssetToBookmark(bookmarkId, assetId);
      pushed.add(key);
      // Persist after EACH success (a fresh array snapshot, not the live Set)
      // so a later failure in this same loop can't lose the record — those
      // assets must not be re-pushed (no duplicates), while unreached/failed
      // ones stay unrecorded and retry next export.
      await savePushedAssetKeys(bookmarkId, [...pushed]);
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}
