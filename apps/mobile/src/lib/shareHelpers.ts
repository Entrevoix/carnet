/**
 * Helpers for the Android share-intent receiver pipeline.
 *
 * Three concerns live here, kept together because they all serve the
 * "user shared an arbitrary file into carnet" flow and the same callers
 * always need them:
 *   - safe interpolation of untrusted shared metadata into YAML + markdown,
 *   - a uniform base64 read for content:// vs file:// URIs,
 *   - a soft cap on binary-share size to avoid OOM-killing the process on
 *     low-RAM phones (a 500MB file becomes ~670MB of base64 in the JS heap
 *     plus another ~500MB while writeBinary serializes to the SAF call —
 *     enough to crash a 4GB device with no error surfaced to the user).
 */

import * as FileSystem from "expo-file-system/legacy";

const { StorageAccessFramework } = FileSystem;

/** Soft cap for non-image binary shares. Beyond this size the base64 read
 * plus the writeBinary serialization can OOM a 4GB phone with no recovery —
 * the process is killed and the share is silently lost. Hard-throw above
 * this limit with a user-actionable message instead. */
export const MAX_SAFE_SHARE_BYTES = 200 * 1024 * 1024;

/** Base64 expands input by ~4/3. Used to bound the post-read length check
 * for shares where the OS didn't populate file.size before the read. */
export const BASE64_EXPANSION = 1.4;

/**
 * Strip CR/LF from a string so it can be safely interpolated into a
 * single-line markdown context (H1, link text, frontmatter values, etc.)
 * without breaking surrounding structure. Used as the first line of defense
 * against malicious or buggy share senders that put control chars in
 * filenames or mime types.
 */
export function sanitizeShareString(v: string): string {
  return v.replace(/[\r\n]/g, " ");
}

/**
 * Quote a string as a YAML double-quoted scalar, safe for frontmatter values.
 * Escapes backslash and double-quote per YAML 1.2 spec; strips newlines so a
 * malicious mime like `application/pdf\nsecret: leak` can't inject a new
 * frontmatter field. Intended for untrusted, single-line user/share data —
 * not for arbitrary YAML.
 */
export function yamlQuote(v: string): string {
  const safe = v
    .replace(/[\r\n]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${safe}"`;
}

/**
 * Read a file from a share-intent path as base64. The intent provider may
 * hand carnet a `content://` URI (Photos via FileProvider, etc.) or a raw
 * `file://` path — they go through different APIs but produce the same
 * base64-encoded payload string.
 *
 * Throws whatever the underlying FileSystem / SAF call throws — caller
 * decides how to surface (typically the outer save() try/catch).
 */
/**
 * Pick the readable URI for a shared file's bytes.
 *
 * expo-share-intent's `path` is often a RAW filesystem path
 * (`file:///storage/emulated/0/Download/...`, resolved from MediaStore's
 * `_data` column) that scoped storage forbids this app from reading — a real
 * Files-app .txt share failed exactly this way on-device (2026-07-14). The
 * `contentUri` is the OS-granted handle from the share intent itself and is
 * the only reliably-readable one, so it wins whenever present. `path` remains
 * the fallback (iOS, and cache-copied files where no contentUri survives).
 * `contentUri` exists via the repo's expo-share-intent patch, which threads
 * it through the library's JS parser (upstream drops it).
 */
export function shareFileReadUri(file: {
  path: string;
  contentUri?: string | null;
}): string {
  return file.contentUri || file.path;
}

export async function readShareFileAsBase64(path: string): Promise<string> {
  if (path.startsWith("content://")) {
    return await StorageAccessFramework.readAsStringAsync(path, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  return await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Format a millisecond duration as `MM:SS` for a timer display. Negative
 * inputs clamp to `00:00` (defensive against clock-skew or
 * intentionally-stale state). Lifted out of AudioCaptureScreen so it's
 * unit-testable and importable from any future timer surface.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
