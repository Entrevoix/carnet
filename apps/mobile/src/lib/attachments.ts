/**
 * Attachment picking for the Idea / Journal capture flow.
 *
 * Wraps expo-document-picker into a single helper that picks one file, reads it
 * to base64, classifies it as image-vs-file, and enforces the same OOM size cap
 * the share-intent receiver uses. The picked attachment still holds its bytes;
 * the caller writes it to the vault via `writeBinary` and turns it into an
 * `AttachmentRef` (see writer.ts) before embedding or queuing it.
 *
 * Deliberately depends only on shareHelpers (read + sanitize + caps) so the
 * unit tests don't have to drag in the writer→settings→expo-secure-store chain.
 */

import * as DocumentPicker from "expo-document-picker";

import {
  BASE64_EXPANSION,
  MAX_SAFE_SHARE_BYTES,
  readShareFileAsBase64,
  sanitizeShareString,
} from "./shareHelpers";

export type AttachmentKind = "image" | "file";

/** A freshly-picked attachment, bytes in hand, not yet written to the vault. */
export interface PickedAttachment {
  base64: string;
  /** Sanitized MIME from the picker, or `application/octet-stream` if absent. */
  mime: string;
  /** Sanitized original filename — used as the slug base + display label. */
  filename: string;
  kind: AttachmentKind;
}

/**
 * Open the system document picker and return the chosen attachment, or null if
 * the user cancelled. `imagesOnly` narrows the picker to images for the
 * dedicated "Attach image" affordance; otherwise any file type is allowed.
 *
 * Throws a user-actionable error when the file exceeds the share cap — the
 * base64 read plus the writeBinary serialization can OOM-kill a low-RAM phone
 * with no recovery, so we hard-stop above the limit rather than crash silently.
 */
export async function pickAttachment(opts?: {
  imagesOnly?: boolean;
}): Promise<PickedAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    // A readable cache file:// URI is returned immediately; some providers
    // still hand back content://, which readShareFileAsBase64 also handles.
    copyToCacheDirectory: true,
    type: opts?.imagesOnly ? "image/*" : "*/*",
  });

  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) return null;

  const mime = sanitizeShareString(asset.mimeType ?? "application/octet-stream");
  const filename = sanitizeShareString(asset.name ?? "attachment");

  // Cheap pre-check when the picker populated `size` — fail before the read.
  if (typeof asset.size === "number" && asset.size > MAX_SAFE_SHARE_BYTES) {
    throw new Error(capMessage(asset.size));
  }

  const base64 = await readShareFileAsBase64(asset.uri);

  // Belt-and-suspenders: some providers don't populate `size`, so re-check the
  // decoded byte count via base64's ~4/3 inflation before anything writes it.
  if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) {
    throw new Error(capMessage());
  }

  const kind: AttachmentKind = mime.startsWith("image/") ? "image" : "file";
  return { base64, mime, filename, kind };
}

/** Friendly cap message. Takes the known byte size when available. */
function capMessage(bytes?: number): string {
  const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
  const sizeStr =
    typeof bytes === "number" ? `${Math.round(bytes / 1024 / 1024)} MB — ` : "";
  return `${sizeStr}attachments are capped at ${capMb} MB to avoid running out of memory. Pick a smaller file.`;
}
