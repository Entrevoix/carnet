/**
 * Local markdown writer for carnet v0.2+.
 *
 * Writes notes under the user-configured `captureFolderPath` setting, or
 * the app sandbox `${FileSystem.documentDirectory}carnet/` if unset.
 * Directory structure inside that root:
 *   Ideas/{slug}.md            — one file per idea
 *   Journal/YYYY-MM-DD.md      — daily journal, append-on-existing
 *   People/{Firstname-Lastname}.md — one file per contact
 *
 * Storage paths come in two flavors:
 *   - `file://...` — direct filesystem path inside the app sandbox or a
 *     legacy raw Android path. Uses the regular expo-file-system API.
 *   - `content://...tree/...` — Android Storage Access Framework URI granted
 *     persistently by the OS document picker. Uses StorageAccessFramework
 *     API (createFileAsync, readDirectoryAsync, etc.) because raw
 *     concatenation doesn't work on SAF URIs.
 *
 * The branching is concentrated in resolveRoot/findOrCreateSubdir/
 * findFileInDir/writeNewFile/readByUri/writeByUri so the public API
 * (writeIdea, appendJournal, writePerson, readNote, updateNote) stays the
 * same shape callers depend on.
 */

import * as FileSystem from "expo-file-system/legacy";
import { getSettings } from "./settings";

const { StorageAccessFramework } = FileSystem;

/** Upper bound on collision-bumped filename variants ({stem}-2.md … {stem}-99.md).
 * If 99 variants are taken, the user has a real cleanup problem and we throw
 * rather than silently overwriting. Same ceiling for ideas / people / binaries. */
const MAX_COLLISION_VARIANTS = 100;

interface Root {
  /** Either a `file://` URI or a `content://...tree/...` SAF tree URI. */
  uri: string;
  /** True when `uri` is a SAF URI and SAF APIs must be used. */
  isSaf: boolean;
}

/**
 * Resolve the root folder URI from settings.
 *   - empty / default → app sandbox carnet/
 *   - content://...tree/... → SAF tree URI as-is
 *   - anything else → treat as a file:// URI (legacy raw Android path)
 */
async function resolveRoot(): Promise<Root> {
  const { captureFolderPath } = await getSettings();
  const trimmed = captureFolderPath.trim();
  if (!trimmed) {
    const base = FileSystem.documentDirectory ?? "file:///data/user/0/carnet/files/";
    return { uri: `${base.replace(/\/$/, "")}/carnet`, isSaf: false };
  }
  if (trimmed.startsWith("content://")) {
    return { uri: trimmed, isSaf: true };
  }
  // Best-effort: file:// or raw path. Ensure file:// prefix for FileSystem API.
  const uri = trimmed.startsWith("file://") ? trimmed : `file://${trimmed}`;
  return { uri, isSaf: false };
}

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
  const slash = m.indexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : "bin";
}

/**
 * Extract the filename/subdir name from a SAF document or tree URI. SAF URIs:
 *   tree:     content://authority/tree/{encoded-tree-id}
 *   document: content://authority/tree/{encoded-tree-id}/document/{encoded-document-id}
 *
 * The encoded id (after `/document/` or `/tree/`) decodes into something like
 * `primary:Download/Carnet/Ideas/myidea.md` — the filename is the last `/`
 * segment of that decoded id. We deliberately do NOT decode the whole URI,
 * which would mangle the authority component that contains its own `/`s.
 */
export function safLastSegment(uri: string): string {
  const docMarker = uri.indexOf("/document/");
  const treeMarker = uri.indexOf("/tree/");
  let encodedId: string;
  if (docMarker >= 0) {
    encodedId = uri.slice(docMarker + "/document/".length);
  } else if (treeMarker >= 0) {
    encodedId = uri.slice(treeMarker + "/tree/".length);
  } else {
    return uri;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedId);
  } catch {
    decoded = encodedId;
  }
  const slash = decoded.lastIndexOf("/");
  if (slash >= 0) return decoded.slice(slash + 1);
  // No slash — handle root-of-volume case like "primary:foldername"
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : decoded;
}

/**
 * List the names of all children in `parentUri`. Single IPC call on SAF
 * (vs. one per collision probe), single readDirectory on file://. Callers
 * use the returned Set to probe many candidate names in O(1) each.
 */
async function listChildNames(parentUri: string, isSaf: boolean): Promise<Set<string>> {
  if (isSaf) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return new Set(children.map(safLastSegment));
  }
  try {
    const names = await FileSystem.readDirectoryAsync(parentUri);
    return new Set(names);
  } catch {
    // Directory may not exist yet — first write into a fresh subdir.
    return new Set();
  }
}

/**
 * Resolve a collision-free filename of shape `{base}{ext}` or `{base}-N{ext}`.
 * Lists the directory once and probes against an in-memory Set so the SAF
 * branch doesn't pay one IPC round-trip per probe.
 */
async function findCollisionFreeName(
  parentUri: string,
  base: string,
  ext: string,
  isSaf: boolean,
): Promise<string> {
  const existing = await listChildNames(parentUri, isSaf);
  const first = `${base}${ext}`;
  if (!existing.has(first)) return first;
  for (let n = 2; n < MAX_COLLISION_VARIANTS; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(
    `More than ${MAX_COLLISION_VARIANTS - 1} files with stem "${base}" — clean up duplicates first`,
  );
}

/** Find an existing child file in `parentUri` whose name matches, or null.
 * Used by appendJournal where we need the URI to read+rewrite. Other
 * collision checks should use findCollisionFreeName which lists once. */
async function findFileInDir(
  parentUri: string,
  filename: string,
  isSaf: boolean,
): Promise<string | null> {
  if (isSaf) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return children.find((u) => safLastSegment(u) === filename) ?? null;
  }
  const fileUri = `${parentUri.replace(/\/$/, "")}/${filename}`;
  const info = await FileSystem.getInfoAsync(fileUri);
  return info.exists ? fileUri : null;
}

/** Get or create a named subdirectory, returning its URI. */
async function findOrCreateSubdir(root: Root, name: string): Promise<string> {
  if (root.isSaf) {
    const children = await StorageAccessFramework.readDirectoryAsync(root.uri);
    const existing = children.find((u) => safLastSegment(u) === name);
    if (existing) return existing;
    return await StorageAccessFramework.makeDirectoryAsync(root.uri, name);
  }
  const dir = `${root.uri.replace(/\/$/, "")}/${name}`;
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

/** Create a new file in `parentUri` with `filename` and write `content`.
 * Returns the URI of the new file. Caller must guarantee `filename` is
 * collision-free (i.e. has already been verified via findFileInDir). */
async function writeNewFile(
  parentUri: string,
  filename: string,
  content: string,
  isSaf: boolean,
): Promise<string> {
  if (isSaf) {
    const fileUri = await StorageAccessFramework.createFileAsync(
      parentUri,
      filename,
      "text/markdown",
    );
    await StorageAccessFramework.writeAsStringAsync(fileUri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return fileUri;
  }
  const fileUri = `${parentUri.replace(/\/$/, "")}/${filename}`;
  await FileSystem.writeAsStringAsync(fileUri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return fileUri;
}

/** Read a file by its URI (handles both file:// and content://). */
async function readByUri(uri: string): Promise<string> {
  if (uri.startsWith("content://")) {
    return await StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  }
  return await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** Overwrite a file by its URI. */
async function writeByUri(uri: string, content: string): Promise<void> {
  if (uri.startsWith("content://")) {
    await StorageAccessFramework.writeAsStringAsync(uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return;
  }
  await FileSystem.writeAsStringAsync(uri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** Read a binary file (image, audio, generic file) as base64 from either
 * storage backend. Used by the archive flow when relocating a paired binary. */
async function readBinaryByUri(uri: string, isSaf: boolean): Promise<string> {
  if (isSaf) {
    return StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** Write a base64-encoded binary into `parentUri/filename`. Mime is generic
 * — Android attaches it but the file extension is what consumers actually
 * use. SAF requires createFileAsync first; file:// can write directly. */
async function writeBinaryBytes(
  parentUri: string,
  filename: string,
  base64: string,
  isSaf: boolean,
): Promise<string> {
  if (isSaf) {
    const fileUri = await StorageAccessFramework.createFileAsync(
      parentUri,
      filename,
      "application/octet-stream",
    );
    await StorageAccessFramework.writeAsStringAsync(fileUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return fileUri;
  }
  const fileUri = `${parentUri.replace(/\/$/, "")}/${filename}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return fileUri;
}

/** Delete a file by URI. The file:// branch passes `idempotent: true` so a
 * retry after a partial archive doesn't crash. SAF deleteAsync is NOT
 * idempotent — it throws when the user revoked the tree permission AND
 * when the file is already gone. Callers should wrap in try/catch and
 * accept a stranded source (the archive copy still exists). */
async function deleteByUri(uri: string, isSaf: boolean): Promise<void> {
  if (isSaf) {
    await StorageAccessFramework.deleteAsync(uri);
    return;
  }
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

/**
 * Inject a markdown image embed `![](relPath)` immediately under the first
 * H1 line of `markdown`. If there is no H1, prepend the embed at the top.
 *
 * The earlier inline `/^(#\s+.+\n)/m` regex silently no-op'd when the H1
 * had no trailing newline (e.g. last line of a model response), dropping
 * the embed. This helper handles `\n` and end-of-string equally.
 */
/**
 * Idempotently insert-or-replace an H2 section in a markdown body.
 *
 *   - If `## {heading}` exists, replace everything from that line through
 *     the next `## ` / `# ` line (or end-of-file) with the new content.
 *   - If it doesn't exist, append a new section at the end with one blank
 *     line of separation from the prior content.
 *
 * Heading match is exact-line and case-sensitive (`## Transcript` matches;
 * `## Transcript ` with trailing space does not, neither does `##  Foo`
 * with double space). This is deliberate: Obsidian's heading parser is
 * strict, and exact-match means re-runs always find their own section
 * back without surprises from whitespace drift.
 *
 * Section boundary stops at H1 and H2 only. H3+ subheadings are treated as
 * part of the current section's body, so a transcript can include
 * `### Speakers` without being truncated.
 *
 * Pure function — no I/O. Caller wires `updateNote` to persist the result.
 */
export function upsertSection(
  markdown: string,
  heading: string,
  body: string,
): string {
  // Heading with a newline would break exact-line match (findIndex misses)
  // AND emit a malformed heading on append. Defensive — current caller
  // passes the literal "Transcript" but the helper is exported as general
  // utility.
  if (heading.includes("\n") || heading.includes("\r")) {
    throw new Error("upsertSection: heading cannot contain newlines");
  }

  const headingLine = `## ${heading}`;
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((l) => l === headingLine);

  if (startIdx === -1) {
    // Append. Normalize trailing newlines so output always ends with
    // exactly one newline after the appended body. Skip the leading "\n\n"
    // separator entirely when markdown is empty so the output doesn't start
    // with phantom blank lines.
    const trimmed = markdown.replace(/\n+$/, "");
    const separator = trimmed.length === 0 ? "" : "\n\n";
    return `${trimmed}${separator}${headingLine}\n\n${body}\n`;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const replacement = [headingLine, "", body];
  // Preserve a blank line between the new section and whatever follows.
  // If `after` is empty (section was at EOF), no separator needed.
  if (after.length > 0 && after[0] !== "") replacement.push("");
  return [...before, ...replacement, ...after].join("\n");
}

export function injectImageEmbed(markdown: string, relPath: string): string {
  const embed = `![](${relPath})`;
  // Match the H1 line and capture its trailing newline (if any).
  const match = markdown.match(/^(#\s+.+?)(\r?\n|$)/m);
  if (!match) return `${embed}\n\n${markdown}`;
  const idx = match.index ?? 0;
  const before = markdown.slice(0, idx + match[1].length);
  const after = markdown.slice(idx + match[0].length);
  return `${before}\n\n${embed}\n${after}`;
}

/** The relative-link convention every binary writer emits: `../{subdir}/{name}`.
 * The filename class `[^/\s)]+` rejects `/` so a crafted `[x](../Photos/../..)`
 * link can't traverse out of the recognized subdir. */
const PAIRED_BINARY_LINK = /\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/g;

type PairedSubdir = "Photos" | "Audio" | "Files";

/** A binary attachment carried alongside a capture: the storage subdir, the
 * collision-bumped on-disk filename, and the `../{subdir}/{name}` relative link
 * used to embed it in the markdown body. Distinct from a freshly-picked
 * attachment (which still holds base64) — this is the post-write reference that
 * survives in the offline queue and the note body. */
export interface AttachmentRef {
  kind: "image" | "file";
  /** `../Photos/sketch.jpg` or `../Files/spec.pdf` */
  rel: string;
  /** Display label + collision-bumped final name on disk. */
  filename: string;
}

/**
 * Fold attachment references into an enriched markdown body. Images become
 * `![](rel)` embeds under the H1 (order preserved); non-image files are
 * collected into a single `## Files` section as a markdown link list.
 *
 * Pure function — the caller writes the binaries to disk first (so `rel`
 * resolves) and persists the returned markdown. Shared by the online capture
 * path (CaptureScreen.confirmSave) and the offline drain (queue.processRow) so
 * both produce byte-identical bodies.
 */
export function injectAttachments(
  markdown: string,
  attachments: readonly AttachmentRef[],
): string {
  let md = markdown;
  // Inject images in reverse: injectImageEmbed inserts each embed immediately
  // under the H1, so reversing keeps the first attachment visually first.
  const images = attachments.filter((a) => a.kind === "image");
  for (let i = images.length - 1; i >= 0; i--) {
    md = injectImageEmbed(md, images[i].rel);
  }
  const files = attachments.filter((a) => a.kind === "file");
  if (files.length > 0) {
    // Blank line between links so adjacent ones don't soft-break onto a single
    // line in raw markdown (Obsidian); each still strips cleanly for display.
    const body = files.map((f) => `[${f.filename}](${f.rel})`).join("\n\n");
    md = upsertSection(md, "Files", body);
  }
  return md;
}

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
  const subdirUri = await findOrCreateSubdir(root, subdir);
  const binaryUri = await findFileInDir(subdirUri, filename, root.isSaf);
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
export function stripPairedBinaryLinks(body: string): string {
  const lineIsPairedLink = (line: string): boolean =>
    /^!?\[[^\]]*\]\(\.\.\/(Photos|Audio|Files)\/[^)]+\)$/.test(line.trim());

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

/**
 * Lowercase ASCII slug with hyphens. Transliterates common French accents
 * so "Mémoire" → "memoire". Non-ASCII non-accent chars are dropped.
 * Unicode-aware slugifier tracked in TODO.md for later.
 */
export function slugify(input: string): string {
  const accentMap: Record<string, string> = {
    à: "a", â: "a", ä: "a", á: "a", ã: "a",
    è: "e", é: "e", ê: "e", ë: "e",
    î: "i", ï: "i", ì: "i", í: "i",
    ô: "o", ö: "o", ò: "o", ó: "o", õ: "o",
    ù: "u", û: "u", ü: "u", ú: "u",
    ç: "c", ñ: "n", ß: "ss",
    À: "a", Â: "a", Ä: "a", Á: "a", Ã: "a",
    È: "e", É: "e", Ê: "e", Ë: "e",
    Î: "i", Ï: "i", Ì: "i", Í: "i",
    Ô: "o", Ö: "o", Ò: "o", Ó: "o", Õ: "o",
    Ù: "u", Û: "u", Ü: "u", Ú: "u",
    Ç: "c", Ñ: "n",
  };

  const folded = input
    .split("")
    .map((c) => accentMap[c] ?? c)
    .join("");

  let out = "";
  let prevDash = true;
  for (const c of folded) {
    if (/[a-zA-Z0-9]/.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

/**
 * Derive filename stem for a person note: "Firstname-Lastname" (preserving
 * case, hyphenating spaces, stripping special chars except hyphens/apostrophes).
 * Strict allowlist — defense in depth against an LLM-controlled name field
 * (which could in theory contain path separators if a prompt injection
 * survived the delimiter guard). Returns "" on bad input; callers fall back.
 */
export function personFilename(name: string): string {
  const cleaned = name
    .split("")
    .filter((c) => /[a-zA-Z0-9\s\-']/.test(c))
    .join("");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const stem = parts.join("-");
  // Allowlist assert: only letters / digits / hyphens / apostrophes survive.
  // ".." or "/" can't appear, but the regex makes the invariant explicit.
  if (!/^[A-Za-z0-9'\-]+$/.test(stem)) return "";
  return stem;
}

/**
 * Extract first/last name from a person markdown note. Tries `name:`
 * frontmatter first, then the H1. Used by CaptureScreen to derive a
 * filename stem before calling writePerson.
 */
export function extractNameFromMarkdown(
  markdown: string,
): { firstName: string; lastName: string } {
  const fromField = extractFrontmatterField(markdown, "name");
  const fromH1 = extractH1(markdown);
  const raw = fromField ?? fromH1;
  if (!raw) return { firstName: "", lastName: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Extract the first H1 title from markdown. */
function extractH1(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      if (title) return title;
    }
  }
  return null;
}

/** Extract a YAML frontmatter field value. Exported so screens (e.g.
 * RecentDetail's retro-enrich gate) can route off the `kind:` field. */
export function extractFrontmatterField(markdown: string, field: string): string | null {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return null;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return null;
  const block = afterFirst.slice(0, endIdx);
  const prefix = `${field}:`;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "");
      if (value) return value;
    }
  }
  return null;
}

/** Strip frontmatter block, returning only the body. Exported so screens
 * that preview a saved note can render the body without the YAML noise. */
export function stripFrontmatter(markdown: string): string {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return markdown;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return markdown;
  return afterFirst.slice(endIdx + 4).replace(/^\n+/, "");
}

/**
 * Split a note into its raw YAML frontmatter header and its body, such that
 * `header + body === markdown` BYTE-FOR-BYTE. Unlike stripFrontmatter (which
 * trims), this preserves the header verbatim so it can be re-prepended exactly
 * after a body-only edit — the #1 documented WYSIWYG corruption mode is the
 * frontmatter block collapsing, so the editor must never see or rewrite it.
 *
 * The header includes the closing `---` line AND its trailing newline, so
 * `header + editedBody` can never merge the closing fence into the body even if
 * the editor drops the blank line that followed it. A note with no valid
 * frontmatter returns `{ header: "", body: markdown }`.
 */
export function splitFrontmatter(markdown: string): { header: string; body: string } {
  if (!markdown.startsWith("---")) return { header: "", body: markdown };
  const afterFirst = markdown.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return { header: "", body: markdown };
  // Index (in afterFirst) of the closing fence's own line; advance past "---"
  // then to the end of that line (its trailing newline, or end of string).
  const closeFenceStart = endIdx + 1;
  const nlAfterClose = afterFirst.indexOf("\n", closeFenceStart + 3);
  const splitAt = 3 + (nlAfterClose === -1 ? afterFirst.length : nlAfterClose + 1);
  return { header: markdown.slice(0, splitAt), body: markdown.slice(splitAt) };
}

/** Rewrite a single YAML frontmatter field, preserving the rest byte-identical. */
export function rewriteFrontmatterField(
  content: string,
  field: string,
  newValue: string,
): string {
  if (newValue.includes("\n") || newValue.includes("\r")) {
    throw new Error("frontmatter values cannot contain newlines or carriage returns");
  }
  const s = content.trimStart();
  if (!s.startsWith("---")) {
    throw new Error("file has no YAML frontmatter");
  }
  const afterFirst = s.slice(3);

  // Line-aware scan for closing --- to avoid mis-cutting on body horizontal rules.
  let blockEnd: number | null = null;
  let offset = 0;
  for (const line of afterFirst.split("\n")) {
    if (line.trim() === "---") {
      blockEnd = offset;
      break;
    }
    offset += line.length + 1; // +1 for the \n
  }
  if (blockEnd === null) {
    throw new Error("unterminated frontmatter block");
  }
  const block = afterFirst.slice(0, blockEnd);
  const body = afterFirst.slice(blockEnd);

  const prefix = `${field}:`;
  let found = false;
  const newBlock = block
    .split("\n")
    .map((line) => {
      if (!found && line.trimStart().startsWith(prefix)) {
        found = true;
        const leadingWs = line.slice(0, line.length - line.trimStart().length);
        return `${leadingWs}${prefix} ${newValue}`;
      }
      return line;
    })
    .join("\n");

  if (!found) {
    throw new Error(`field \`${field}\` not present in frontmatter`);
  }
  return `---${newBlock}${body}`;
}

/**
 * Per-filepath promise chain. Used to serialize concurrent reads-then-writes
 * to the same file (the offline drain may process two journal entries for
 * the same day back-to-back; without serialization the second read sees
 * stale content and overwrites the first). Each entry resolves when the
 * last queued op for that path completes.
 */
const _writeChain = new Map<string, Promise<unknown>>();

/** Serialize work that touches `filepath`. Subsequent calls queue behind
 * any in-flight op on the same path. */
async function serialize<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeChain.get(filepath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _writeChain.set(filepath, next);
  try {
    return (await next) as T;
  } finally {
    if (_writeChain.get(filepath) === next) _writeChain.delete(filepath);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write an idea note. Slug is derived from the markdown H1.
 * Handles collision by appending -2, -3, etc. up to -99.
 */
export async function writeIdea(
  slug: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = await resolveRoot();
  const ideasUri = await findOrCreateSubdir(root, "Ideas");
  const filename = await findCollisionFreeName(ideasUri, slug, ".md", root.isSaf);
  const filepath = await writeNewFile(ideasUri, filename, markdown, root.isSaf);
  return { filepath };
}

/**
 * Append a journal entry to today's file. If the file already exists, the new
 * entry's body (frontmatter stripped) is appended under a `## HH:MM` heading.
 *
 * Read-then-write is serialized per-filepath so two captures arriving in
 * quick succession (e.g. during an offline drain pass) don't both read the
 * same baseline and clobber each other.
 */
export async function appendJournal(
  date: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = await resolveRoot();
  const journalUri = await findOrCreateSubdir(root, "Journal");
  const filename = `${date}.md`;

  // Serialize per (journalUri + filename) so two concurrent appends to today's
  // file (e.g. an offline drain pass) don't read the same baseline and clobber.
  // The journalUri may be a content:// URI when SAF is in play; that's fine —
  // it's still unique per file.
  const lockKey = `${journalUri}/${filename}`;

  return serialize(lockKey, async () => {
    const existingUri = await findFileInDir(journalUri, filename, root.isSaf);

    if (existingUri) {
      const existing = await readByUri(existingUri);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const appended = stripFrontmatter(markdown);
      const finalMarkdown = `${existing.trimEnd()}\n\n## ${hhmm}\n\n${appended.trimStart()}`;
      await writeByUri(existingUri, finalMarkdown);
      return { filepath: existingUri };
    }

    const filepath = await writeNewFile(journalUri, filename, markdown, root.isSaf);
    return { filepath };
  });
}

/**
 * Write a person (contact) note. Filename derived from the `name:` frontmatter
 * field or the H1 title.
 *
 * Collision behavior: if a file with the same stem exists, the new note
 * lands as `{stem}-2.md`, `{stem}-3.md`, etc. up to -99. Same person
 * captured twice does NOT silently overwrite — Obsidian on desktop may
 * have edits we shouldn't destroy. The user can manually merge duplicates.
 */
export async function writePerson(
  firstName: string,
  lastName: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = await resolveRoot();
  const peopleUri = await findOrCreateSubdir(root, "People");

  // Use provided names if non-empty; fall back to frontmatter/H1.
  let stem: string;
  if (firstName.trim() || lastName.trim()) {
    stem = personFilename(`${firstName} ${lastName}`.trim());
  } else {
    const fromFrontmatter = extractFrontmatterField(markdown, "name");
    const fromH1 = extractH1(markdown);
    const raw = fromFrontmatter ?? fromH1 ?? "Unknown Person";
    stem = personFilename(raw);
  }
  if (!stem) stem = "Unknown-Person";

  const filename = await findCollisionFreeName(peopleUri, stem, ".md", root.isSaf);
  const filepath = await writeNewFile(peopleUri, filename, markdown, root.isSaf);
  return { filepath };
}

/**
 * Save a binary file (e.g. an image shared into carnet) under `subdir`
 * with the given filename. base64-encoded content. Handles collision by
 * appending -2, -3, … like the markdown writers do. Returns the URI of
 * the written file.
 *
 * The two storage modes diverge here:
 *   - SAF: createFileAsync with the mime type, then writeAsStringAsync
 *     with base64 encoding.
 *   - file://: writeAsStringAsync with base64 encoding directly.
 */
export async function writeBinary(
  subdir: string,
  filename: string,
  base64: string,
  mimeType: string,
): Promise<{ filepath: string; finalName: string }> {
  const root = await resolveRoot();
  const dirUri = await findOrCreateSubdir(root, subdir);

  const dot = filename.lastIndexOf(".");
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : "";

  const finalName = await findCollisionFreeName(dirUri, stem, ext, root.isSaf);

  let filepath: string;
  if (root.isSaf) {
    filepath = await StorageAccessFramework.createFileAsync(dirUri, finalName, mimeType);
    await StorageAccessFramework.writeAsStringAsync(filepath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else {
    filepath = `${dirUri.replace(/\/$/, "")}/${finalName}`;
    await FileSystem.writeAsStringAsync(filepath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  return { filepath, finalName };
}

/** Read the raw string content of a note file. Supports both file:// and content:// URIs. */
export async function readNote(filepath: string): Promise<string> {
  return readByUri(filepath);
}

/** Overwrite a note file with new content. Supports both file:// and content:// URIs. */
export async function updateNote(filepath: string, markdown: string): Promise<void> {
  await writeByUri(filepath, markdown);
}

/**
 * Soft-delete a note. Copies the .md (and any paired binary referenced by a
 * relative `../{Photos|Audio|Files}/{name}.{ext}` link in the body) into the
 * vault's `Archive/` subdir with collision-bumped names, then removes the
 * originals. Used by RecentDetail's Delete button so a misfire can be
 * recovered by browsing the vault in Obsidian.
 *
 * Returns the new .md path plus the archived binary paths. `archivedBinaryPath`
 * is the FIRST archived binary (kept for back-compat with single-binary
 * callers); `archivedBinaryPaths` lists all of them. Both are empty/null when
 * the body has no recognized relative link or every link's target was missing
 * on disk (broken link from a prior external edit — archive the .md, accept
 * the orphan).
 *
 * Multi-binary: every `../{Photos|Audio|Files}/{name}` link in the body is
 * followed. Legacy notes (photo, share-image, share-audio, share-file) carry
 * exactly one; capture-with-attachments notes can carry several.
 *
 * Delete failures (SAF revoked the tree permission, file already gone) are
 * swallowed — the archive copy succeeded and is the source of truth for
 * recovery; the stranded original is acceptable.
 */
export async function moveToArchive(
  filepath: string,
): Promise<{
  archivedMdPath: string;
  archivedBinaryPath: string | null;
  archivedBinaryPaths: string[];
}> {
  const root = await resolveRoot();
  const archiveUri = await findOrCreateSubdir(root, "Archive");

  const content = await readByUri(filepath);

  // Build collision-free archive name for the .md.
  const mdName = filepath.split("/").pop() ?? "note.md";
  const mdDot = mdName.lastIndexOf(".");
  const mdStem = mdDot >= 0 ? mdName.slice(0, mdDot) : mdName;
  const mdExt = mdDot >= 0 ? mdName.slice(mdDot) : ".md";
  const mdArchiveName = await findCollisionFreeName(
    archiveUri,
    mdStem,
    mdExt,
    root.isSaf,
  );
  const archivedMdPath = await writeNewFile(
    archiveUri,
    mdArchiveName,
    content,
    root.isSaf,
  );

  // Archive every paired binary referenced by the body (each resolvable one).
  // The filename class in PAIRED_BINARY_LINK rejects `/`, so a crafted
  // `[x](../Photos/../../secret)` link can't traverse out of the subdir — this
  // is defense-in-depth; today's writers emit slugified ASCII names.
  const archivedBinaryPaths: string[] = [];
  const binaryOriginals: string[] = [];
  for (const pb of listPairedBinaries(content)) {
    const subdirUri = await findOrCreateSubdir(root, pb.subdir);
    const binUri = await findFileInDir(subdirUri, pb.filename, root.isSaf);
    if (!binUri) continue; // broken link — archive the .md, accept the orphan
    const binDot = pb.filename.lastIndexOf(".");
    const binStem = binDot >= 0 ? pb.filename.slice(0, binDot) : pb.filename;
    const binExt = binDot >= 0 ? pb.filename.slice(binDot) : "";
    const binArchiveName = await findCollisionFreeName(
      archiveUri,
      binStem,
      binExt,
      root.isSaf,
    );
    const binBase64 = await readBinaryByUri(binUri, root.isSaf);
    const archived = await writeBinaryBytes(
      archiveUri,
      binArchiveName,
      binBase64,
      root.isSaf,
    );
    archivedBinaryPaths.push(archived);
    binaryOriginals.push(binUri);
  }

  // Best-effort delete of the originals — see jsdoc.
  try {
    await deleteByUri(filepath, root.isSaf);
  } catch {
    /* leave the original; archive copy is canonical */
  }
  for (const orig of binaryOriginals) {
    try {
      await deleteByUri(orig, root.isSaf);
    } catch {
      /* leave the original binary */
    }
  }

  return {
    archivedMdPath,
    archivedBinaryPath: archivedBinaryPaths[0] ?? null,
    archivedBinaryPaths,
  };
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
  // content:// vs file:// is the same discriminator resolveRoot uses; derive it
  // from the resolved URI so this reader doesn't need the Root back.
  const base64 = await readBinaryByUri(
    resolved.uri,
    resolved.uri.startsWith("content://"),
  );
  return { base64, mime: resolved.mime };
}
