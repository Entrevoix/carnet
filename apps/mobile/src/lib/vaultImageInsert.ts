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
import { BASE64_EXPANSION, MAX_SAFE_SHARE_BYTES } from "./shareHelpers";

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

/**
 * Same write→rel step as above, for bytes that are already in hand — a camera
 * capture rather than a picked file. `basename` is slugified (extension
 * stripped) into the filename stem; it defaults to `photo`.
 *
 * Throws when the capture exceeds the attachment size cap. That check lives in
 * `pickAttachment` for the picker path and is bypassed entirely here, so it is
 * re-applied: `quality: 0.6` on expo-camera bounds JPEG compression but NOT
 * resolution, so a high-megapixel sensor can still produce a payload that
 * OOM-kills a low-RAM device while writeBinary serializes it.
 */
export async function writeCapturedVaultImage(
  base64: string,
  mime: string,
  basename?: string,
): Promise<VaultImageInsert> {
  if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) {
    const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
    throw new Error(
      `Photos are capped at ${capMb} MB to avoid running out of memory. Try a lower-resolution capture.`,
    );
  }
  const ext = extFromMime(mime);
  const base = slugify((basename ?? "photo").replace(/\.[^.]+$/, "")) || "photo";
  const { finalName } = await writeBinary("Photos", `${base}.${ext}`, base64, mime);
  const rel = `../Photos/${finalName}`;
  const dataUri =
    base64.length <= MAX_EDITOR_IMAGE_BASE64 ? toDataUri(mime, base64) : null;
  return { rel, dataUri };
}
