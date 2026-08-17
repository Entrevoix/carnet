/**
 * The paired-binary convention: a note's markdown body references its binaries
 * by the relative link `../{Photos|Audio|Files}/{name}`, and the bytes live in
 * that sibling subdir of the vault root.
 *
 * Everything that reads, resolves, or strips those links lives here — link
 * enumeration (listPairedBinaries), URI resolution against the active vault
 * root (resolvePairedUri and the two readPairedBinary* readers), display-time
 * stripping (stripPairedBinaryLinks), plus the MIME↔extension mapping the
 * writers and readers share. The WRITE side (writeBinary, moveToArchive) stays
 * in writer.ts, which imports from here.
 */

import { fsForUri } from "./vaultFs";
import { resolveRoot } from "./vaultRoot";

/** Map a MIME type to a sensible file extension for binary writes. Covers
 * the image types we accept on share intent + a few common audio/document
 * types we'll grow into. Falls back to `bin` rather than guessing wrong. */
export function extFromMime(mime?: string): string {
  if (!mime) return "bin";
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "image/heic") return "heic";
  if (m === "image/heif") return "heif";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/mp4" || m === "audio/m4a") return "m4a";
  if (m === "application/pdf") return "pdf";
  // Common document/archive types shared into carnet. Without these the
  // generic subtype fallback below produces monsters like
  // `report.vnd.openxmlformats-officedocument.wordprocessingml.document` —
  // and SAF's createFileAsync then RENAMES the file by appending the
  // mime-canonical extension (`.docx`), which used to desync the on-disk
  // name from the note's ../Files/ link (broken pairing: attachments
  // silently skipped Karakeep export and were orphaned on archive).
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (m === "application/msword") return "doc";
  if (m === "application/vnd.ms-excel") return "xls";
  if (m === "text/plain") return "txt";
  if (m === "text/markdown") return "md";
  if (m === "text/csv") return "csv";
  if (m === "application/zip") return "zip";
  if (m === "application/json") return "json";
  const slash = m.indexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : "bin";
}

/** The relative-link convention every binary writer emits: `../{subdir}/{name}`.
 * The filename class `[^/\s)]+` rejects `/` so a crafted `[x](../Photos/../..)`
 * link can't traverse out of the recognized subdir. */
const PAIRED_BINARY_LINK = /\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/g;

type PairedSubdir = "Photos" | "Audio" | "Files";

export interface PairedBinary {
  subdir: PairedSubdir;
  filename: string;
  /** `../{subdir}/{filename}` — the exact link text found in the body. */
  rel: string;
}

/**
 * List every paired binary referenced by a note body (`../{Photos|Audio|Files}/
 * {name}`), de-duplicated by relative path. Replaces the single-`.match()`
 * lookups so a capture with several attachments archives/renders all of them.
 */
export function listPairedBinaries(body: string): PairedBinary[] {
  const out: PairedBinary[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(PAIRED_BINARY_LINK)) {
    const rel = `../${m[1]}/${m[2]}`;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ subdir: m[1] as PairedSubdir, filename: m[2], rel });
  }
  return out;
}

/**
 * Resolve a paired binary's storage URI + inferred MIME without reading bytes.
 * Returns null when the file isn't on disk (a broken link from an external
 * rename/move). Factored out of readPairedBinaryUri so RecentDetail's
 * Attachments card can resolve many links, while the single-match callers keep
 * their friendly throw-on-missing contract.
 */
export async function resolvePairedUri(
  subdir: string,
  filename: string,
): Promise<{ uri: string; mime: string } | null> {
  const root = await resolveRoot();
  const subdirUri = await root.fs.findSubdir(root.uri, subdir);
  if (!subdirUri) return null; // subdir absent — broken link, don't create it
  const binaryUri = await root.fs.findChild(subdirUri, filename);
  if (!binaryUri) return null;
  return { uri: binaryUri, mime: mimeFromFilename(filename) };
}

/**
 * Strip paired-binary embeds/links from a body for display. RecentDetail now
 * renders attachments in a dedicated card (images inline, files as tappable
 * rows), so the raw `![](../Photos/x)` / `[name](../Files/x)` markdown — which
 * the renderer can't resolve anyway — is removed to keep the prose clean.
 *
 * Only whole-line embeds/links are removed (an inline `[see this](../Files/x)`
 * mid-sentence is left intact). A `## File` / `## Files` heading whose only
 * content was the stripped link is dropped too, so no empty heading is left
 * behind. Display-only — callers keep the original body for playback,
 * transcription, re-enrich, and edit.
 */
export function stripPairedBinaryLinks(
  body: string,
  opts?: { keepImages?: boolean },
): string {
  // With `keepImages`, leave `../Photos/` image embeds in the prose so the
  // detail view can render them INLINE (a custom markdown image rule resolves
  // each to a device URI); only Audio (dedicated player) and Files (tappable
  // rows) are pulled out. Default — no opts — strips all three, as before.
  const subdirs = opts?.keepImages ? "Audio|Files" : "Photos|Audio|Files";
  const pairedLinkLine = new RegExp(
    `^!?\\[[^\\]]*\\]\\(\\.\\.\\/(?:${subdirs})\\/[^)]+\\)$`,
  );
  const lineIsPairedLink = (line: string): boolean =>
    pairedLinkLine.test(line.trim());

  // Pass 1: drop standalone embed/link lines.
  const kept = body.split("\n").filter((l) => !lineIsPairedLink(l));

  // Pass 2: drop a "## File"/"## Files" heading left with no body content.
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const trimmed = kept[i].trim();
    if (trimmed === "## File" || trimmed === "## Files") {
      let hasContent = false;
      for (let j = i + 1; j < kept.length; j++) {
        const next = kept[j].trim();
        if (next === "") continue;
        if (next.startsWith("# ") || next.startsWith("## ")) break;
        hasContent = true;
        break;
      }
      if (!hasContent) continue;
    }
    out.push(kept[i]);
  }

  // Collapse the blank-line runs left by removals; keep a single trailing \n.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n");
}

/** Best-effort inverse of `extFromMime` for the file extensions we actually
 * write into the vault. Returns "application/octet-stream" for unknowns so
 * downstream code (e.g. `enrichSharedImage`) gets to surface its own error
 * about an unsupported type, rather than us guessing wrong. */
export function mimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    zip: "application/zip",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Locate the paired binary referenced by a note's body and return its URI
 * + filename + inferred MIME — WITHOUT reading the bytes. Used by the
 * RecentDetail audio player which streams the file via expo-av's
 * Audio.Sound (it accepts a URI directly). Cheaper than
 * readPairedBinaryFromNote for the playback path — no base64 round-trip
 * through JS heap for a 10MB audio file just to hand it to the player.
 *
 * Returned URI is the raw storage URI (file:// or content://) — Audio.Sound
 * handles file:// directly on Android. For content:// SAF URIs the
 * caller may need to first copy to a cache file (expo-av's SAF support is
 * version-dependent); cross that bridge when a SAF user reports playback
 * failing.
 *
 * Same error-message contract as readPairedBinaryFromNote — friendly text
 * for the two failure modes (no link found / target file missing).
 */
export async function readPairedBinaryUri(
  body: string,
): Promise<{ uri: string; mime: string; filename: string }> {
  const linkMatch = body.match(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/);
  if (!linkMatch) {
    throw new Error("No paired binary link found in note.");
  }
  const subdir = linkMatch[1];
  const filename = linkMatch[2];
  const resolved = await resolvePairedUri(subdir, filename);
  if (!resolved) {
    throw new Error(`Paired binary not found: ${subdir}/${filename}`);
  }
  return { uri: resolved.uri, mime: resolved.mime, filename };
}

/**
 * Locate and read the paired binary referenced by a note's body (e.g. the
 * JPEG behind a photo/shared-image .md), returning the base64 payload and
 * the inferred MIME type. Used by RecentDetail's retro-enrich flow when the
 * raw image needs to be re-sent to the vision model days after capture.
 *
 * Resolves the first `../{Photos|Audio|Files}/<name>` link in `body`,
 * looks the file up in that subdir of the active vault root, and reads it
 * as base64. Path-traversal characters in the captured filename are
 * rejected by the regex (matches `moveToArchive`).
 *
 * Throws with a friendly message when:
 *   - the body contains no recognized paired-binary link
 *   - the link target doesn't exist on disk (e.g. user moved or renamed
 *     the binary in Obsidian)
 *
 * Callers should surface the error in a banner — never overwrite the
 * existing note when this fails.
 */
export async function readPairedBinaryFromNote(
  body: string,
): Promise<{ base64: string; mime: string }> {
  const linkMatch = body.match(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/);
  if (!linkMatch) {
    throw new Error("No paired binary link found in note.");
  }
  const subdir = linkMatch[1];
  const filename = linkMatch[2];
  const resolved = await resolvePairedUri(subdir, filename);
  if (!resolved) {
    throw new Error(`Paired binary not found: ${subdir}/${filename}`);
  }
  // The resolved URI's scheme is the same discriminator resolveRoot uses, so
  // pick the backend from the URI directly — this reader doesn't need the Root.
  const base64 = await fsForUri(resolved.uri).readBinary(resolved.uri);
  return { base64, mime: resolved.mime };
}
