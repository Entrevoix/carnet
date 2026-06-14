// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Per-bookmark record of which local attachments have already been uploaded +
// attached to a Karakeep bookmark, so a re-export pushes ONLY the not-yet-synced
// ones (an attachment added after the first export, or one that failed earlier)
// without ever duplicating an asset already on the server.
//
// Backed by AsyncStorage rather than note frontmatter: frontmatter scalar values
// can't hold newlines and split on commas, which is unsafe for the file paths we
// track here (see frontmatter.ts). Mirrors queue.ts's JSON-array-under-one-key
// persistence — one key per bookmark, value = the set of pushed asset keys.

import AsyncStorage from "@react-native-async-storage/async-storage";

const ASSET_SYNC_KEY_PREFIX = "carnet:karakeep-assets:v1:";

function storageKey(bookmarkId: string): string {
  return `${ASSET_SYNC_KEY_PREFIX}${bookmarkId}`;
}

/**
 * The stable key tracked per attachment against a bookmark: the note-relative
 * `{subdir}/{filename}`. A filename is a single path segment (no slashes — see
 * the PAIRED_BINARY_LINK capture in writer.ts), so this is unique and
 * collision-free across a note's attachments.
 *
 * Identity is by path, not content: replacing a file's bytes under the same
 * name is NOT detected as a change (an accepted limitation for this slice —
 * Karakeep assets are immutable uploads anyway).
 */
export function assetKey(subdir: string, filename: string): string {
  return `${subdir}/${filename}`;
}

/**
 * Load the set of attachment keys already uploaded + attached to `bookmarkId`.
 * Returns an empty set on a miss, a corrupt (non-JSON) value, or a non-array
 * payload. De-duplication against the server depends ENTIRELY on this local
 * record: if it is lost (corrupt / cleared / reinstall), the next export
 * re-uploads and re-attaches the same bytes as a fresh Karakeep asset — a
 * duplicate on that one bookmark (wasteful, not corrupting). Failing open to
 * "nothing synced yet" keeps the export working; it is not a server-side
 * idempotency guarantee.
 */
export async function loadPushedAssetKeys(
  bookmarkId: string,
): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(storageKey(bookmarkId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/** Persist the full set of pushed attachment keys for `bookmarkId`. */
export async function savePushedAssetKeys(
  bookmarkId: string,
  keys: Iterable<string>,
): Promise<void> {
  await AsyncStorage.setItem(storageKey(bookmarkId), JSON.stringify([...keys]));
}

/**
 * Forget a bookmark's entire sync record. Used when the bookmark was deleted
 * server-side and recreated under a NEW id (the old id's record is dead, never
 * read again) — clearing it stops AsyncStorage accumulating orphaned records
 * across the app's lifetime. Best-effort: callers fire-and-forget.
 */
export async function clearPushedAssetKeys(bookmarkId: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey(bookmarkId));
}
