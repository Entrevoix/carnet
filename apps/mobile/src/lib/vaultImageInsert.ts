// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared "pick an image → write it into the vault → hand back the embed rel path
 * (+ optional in-editor preview data URI)" flow, lifted out of RecentDetailScreen
 * where the markdown and WYSIWYG image buttons duplicated it almost verbatim.
 * Pure of React; the two screen handlers keep their own in-flight refs + how they
 * splice `rel` into their respective editors.
 */

import { pickAttachment } from "./attachments";
import { extFromMime, slugify, writeBinary } from "./writer";
import { MAX_EDITOR_IMAGE_BASE64, toDataUri } from "./editorImages";

export interface VaultImageInsert {
  /** The `../Photos/<finalName>` embed link for the written image. */
  rel: string;
  /** A `data:` URI for an in-editor preview, or null when the image is over the
   * inline cap (it still inserts + saves — just without an in-editor preview). */
  dataUri: string | null;
}

/**
 * Open the image picker, write the chosen image into `Photos/` (collision-safe
 * filename via writeBinary), and return its embed rel path plus a preview data
 * URI. Returns null when the user cancels the picker (nothing is written).
 * Throws on a pick/write failure — the caller surfaces it as an edit error.
 */
export async function pickAndWriteVaultImage(): Promise<VaultImageInsert | null> {
  const picked = await pickAttachment({ imagesOnly: true });
  if (!picked) return null;
  const ext = extFromMime(picked.mime);
  const base = slugify(picked.filename.replace(/\.[^.]+$/, "")) || "image";
  const { finalName } = await writeBinary(
    "Photos",
    `${base}.${ext}`,
    picked.base64,
    picked.mime,
  );
  const rel = `../Photos/${finalName}`;
  const dataUri =
    picked.base64.length <= MAX_EDITOR_IMAGE_BASE64
      ? toDataUri(picked.mime, picked.base64)
      : null;
  return { rel, dataUri };
}
