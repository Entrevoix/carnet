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
 * Storage paths come in two flavors — `file://...` (expo-file-system legacy)
 * and `content://...tree/...` (Storage Access Framework). The per-backend
 * branching lives behind the `VaultFs` seam in ./vaultFs; this module selects
 * a backend ONCE in resolveRoot (or fsForUri for a caller-supplied URI) and
 * calls its primitives, so the public API (writeIdea, appendJournal,
 * writePerson, readNote, updateNote) stays the same shape callers depend on.
 */

import * as FileSystem from "expo-file-system/legacy";
import { getSettings } from "./settings";
import { fsForUri, safLastSegment, vaultFsFor, type VaultFs } from "./vaultFs";
// Pure frontmatter helpers used internally; the full set is re-exported below.
import {
  extractFrontmatterField,
  getFrontmatterTags,
  setFrontmatterTags,
  stripFrontmatter,
  upsertFrontmatterField,
} from "./frontmatter";

/** Upper bound on collision-bumped filename variants ({stem}-2.md … {stem}-99.md).
 * If 99 variants are taken, the user has a real cleanup problem and we throw
 * rather than silently overwriting. Same ceiling for ideas / people / binaries. */
const MAX_COLLISION_VARIANTS = 100;

interface Root {
  /** Either a `file://` URI or a `content://...tree/...` SAF tree URI. */
  uri: string;
  /** The filesystem backend selected for `uri` (SAF vs file://). */
  fs: VaultFs;
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
    return { uri: `${base.replace(/\/$/, "")}/carnet`, fs: vaultFsFor(false) };
  }
  if (trimmed.startsWith("content://")) {
    return { uri: trimmed, fs: vaultFsFor(true) };
  }
  // Best-effort: file:// or raw path. Ensure file:// prefix for FileSystem API.
  const uri = trimmed.startsWith("file://") ? trimmed : `file://${trimmed}`;
  return { uri, fs: vaultFsFor(false) };
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

// safLastSegment (SAF URI → filename decoder) now lives in ./vaultFs alongside
// the backends that use it; re-exported below so importers of ./writer are
// unaffected.

/**
 * Resolve a collision-free filename of shape `{base}{ext}` or `{base}-N{ext}`.
 * Lists the directory once and probes against an in-memory Set so the SAF
 * backend doesn't pay one IPC round-trip per probe.
 */
async function findCollisionFreeName(
  parentUri: string,
  base: string,
  ext: string,
  fs: VaultFs,
): Promise<string> {
  const children = await fs.listChildren(parentUri);
  const existing = new Set(children.map((c) => c.name));
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

/** Create a new markdown file in `parentUri` with `filename` and write
 * `content`. Returns the URI of the new file (SAF may hand back a renamed URI,
 * but a `.md` name already carries the canonical extension, so it doesn't
 * here). Caller must guarantee `filename` is collision-free. */
async function writeNewFile(
  parentUri: string,
  filename: string,
  content: string,
  fs: VaultFs,
): Promise<string> {
  const fileUri = await fs.createFile(parentUri, filename, "text/markdown");
  await fs.writeString(fileUri, content);
  return fileUri;
}

/** Read a file by its URI (handles both file:// and content://). */
async function readByUri(uri: string): Promise<string> {
  return fsForUri(uri).readString(uri);
}

/** Overwrite a file by its URI. */
async function writeByUri(uri: string, content: string): Promise<void> {
  await fsForUri(uri).writeString(uri, content);
}

/** Write a base64-encoded binary into `parentUri/filename` (generic mime).
 * Used by the archive flow when relocating a paired binary. */
async function writeBinaryBytes(
  parentUri: string,
  filename: string,
  base64: string,
  fs: VaultFs,
): Promise<string> {
  const fileUri = await fs.createFile(parentUri, filename, "application/octet-stream");
  await fs.writeBinaryBytes(fileUri, base64);
  return fileUri;
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

// Frontmatter parse/serialize logic lives in ./frontmatter — a pure, native-free
// module so it can be unit-tested without mocks. Re-exported here so existing
// importers (RecentDetailScreen, CaptureScreen, tests) keep their `./writer`
// import path unchanged.
export {
  extractFrontmatterField,
  stripFrontmatter,
  splitFrontmatter,
  rewriteFrontmatterField,
} from "./frontmatter";

// SAF URI → filename decoder lives in ./vaultFs; re-exported so existing
// importers of ./writer (and the writer test suites) keep their import path.
export { safLastSegment } from "./vaultFs";

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
  const ideasUri = await root.fs.findOrCreateSubdir(root.uri, "Ideas");
  const filename = await findCollisionFreeName(ideasUri, slug, ".md", root.fs);
  const filepath = await writeNewFile(ideasUri, filename, markdown, root.fs);
  return { filepath };
}

/**
 * Append a journal entry to today's file. If the file already exists, the new
 * entry's body (frontmatter stripped) is appended under a `## HH:MM` heading.
 *
 * Read-then-write is serialized per-filepath so two captures arriving in
 * quick succession (e.g. during an offline drain pass) don't both read the
 * same baseline and clobber each other.
 *
 * Returns the day file's full accumulated markdown (every same-day capture
 * merged, with this entry's tags unioned into the frontmatter) alongside its
 * filepath — callers that maintain the note/tag index must index off this,
 * not the just-written fragment, or earlier same-day tags are lost.
 */
export async function appendJournal(
  date: string,
  markdown: string,
): Promise<{ filepath: string; markdown: string }> {
  const root = await resolveRoot();
  const journalUri = await root.fs.findOrCreateSubdir(root.uri, "Journal");
  const filename = `${date}.md`;

  // Serialize per (journalUri + filename) so two concurrent appends to today's
  // file (e.g. an offline drain pass) don't read the same baseline and clobber.
  // The journalUri may be a content:// URI when SAF is in play; that's fine —
  // it's still unique per file.
  const lockKey = `${journalUri}/${filename}`;

  return serialize(lockKey, async () => {
    const existingUri = await root.fs.findChild(journalUri, filename);

    if (existingUri) {
      const existing = await readByUri(existingUri);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // The appended entry's frontmatter is stripped (only the day file's first
      // block survives), so carry this entry's metadata into that block —
      // otherwise tags/location on a 2nd+ same-day capture would be silently lost.
      const newTags = getFrontmatterTags(markdown);
      let base = newTags.length
        ? setFrontmatterTags(existing, [...getFrontmatterTags(existing), ...newTags])
        : existing;
      // Tags accumulate (union); location is a scalar — a day file has one
      // frontmatter, so the latest same-day capture's location wins.
      const newLocation = extractFrontmatterField(markdown, "location");
      if (newLocation) base = upsertFrontmatterField(base, "location", newLocation);
      const appended = stripFrontmatter(markdown);
      const finalMarkdown = `${base.trimEnd()}\n\n## ${hhmm}\n\n${appended.trimStart()}`;
      await writeByUri(existingUri, finalMarkdown);
      return { filepath: existingUri, markdown: finalMarkdown };
    }

    const filepath = await writeNewFile(journalUri, filename, markdown, root.fs);
    return { filepath, markdown };
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
  const peopleUri = await root.fs.findOrCreateSubdir(root.uri, "People");

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

  const filename = await findCollisionFreeName(peopleUri, stem, ".md", root.fs);
  const filepath = await writeNewFile(peopleUri, filename, markdown, root.fs);
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
  const dirUri = await root.fs.findOrCreateSubdir(root.uri, subdir);

  const dot = filename.lastIndexOf(".");
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : "";

  const finalName = await findCollisionFreeName(dirUri, stem, ext, root.fs);

  const filepath = await root.fs.createFile(dirUri, finalName, mimeType);
  await root.fs.writeBinaryBytes(filepath, base64);
  if (root.fs.isSaf) {
    // SAF may RENAME on create: DocumentsContract appends the mime-canonical
    // extension when the display name doesn't already end with it (observed
    // on-device 2026-07-14: requested `agenda-test.vnd.…document`, created
    // `agenda-test.vnd.…document.docx`). The caller links `finalName` in the
    // note body, so it MUST be the name SAF actually created — otherwise the
    // pairing silently breaks (attachment skipped on Karakeep export,
    // orphaned on archive). Derive it from the returned document URI.
    const created = safLastSegment(filepath);
    if (created) return { filepath, finalName: created };
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
 * Read a note file's last-modification time (epoch seconds) via getInfoAsync.
 * Returns null when the file doesn't exist, or when the backend can't report a
 * usable mtime — notably SAF `content://` URIs, which don't expose a reliable
 * modification time. A null baseline means the conflict guard below cannot fire
 * for that file: cross-device edits there resolve to Syncthing
 * `*.sync-conflict-*.md` files instead (see the capture-timing decision memo).
 *
 * This is the primitive the save-first Idea path and the promote-idea race
 * (TODO.md) both need: record it right after a write, re-check it before the
 * next overwrite.
 */
export async function getModificationTime(filepath: string): Promise<number | null> {
  if (filepath.startsWith("content://")) return null;
  try {
    const info = await FileSystem.getInfoAsync(filepath);
    if (!info.exists) return null;
    return typeof info.modificationTime === "number" ? info.modificationTime : null;
  } catch {
    return null;
  }
}

/** Result of a guarded overwrite. `reason: "conflict"` means the file changed
 * under us and the write was deliberately skipped (the on-disk version wins). */
export interface GuardedUpdateResult {
  ok: boolean;
  reason?: "conflict";
}

/**
 * Overwrite a note ONLY if its on-disk mtime still matches `expectedMtime`.
 *
 * Detects a user edit (or a synced workstation edit that already reached the
 * device) landing between when the caller recorded `expectedMtime` and this
 * overwrite. On a mismatch the write is skipped and `{ ok: false,
 * reason: "conflict" }` is returned so the caller can keep the existing version
 * and surface a banner instead of clobbering it.
 *
 * When mtime can't be read (SAF, or a null baseline) the guard cannot fire and
 * the overwrite proceeds — cross-device races there fall back to Syncthing
 * conflict files, exactly as the decision memo describes.
 */
export async function updateNoteIfUnchanged(
  filepath: string,
  markdown: string,
  expectedMtime: number | null,
): Promise<GuardedUpdateResult> {
  if (expectedMtime !== null) {
    const current = await getModificationTime(filepath);
    if (current !== null && current !== expectedMtime) {
      return { ok: false, reason: "conflict" };
    }
  }
  await writeByUri(filepath, markdown);
  return { ok: true };
}

/** Vault subdirs that hold markdown notes. Photos/Audio/Files hold binaries
 * and are deliberately excluded from note enumeration. */
const NOTE_SUBDIRS = ["Ideas", "Journal", "People"] as const;
export type NoteSubdir = (typeof NOTE_SUBDIRS)[number];

export interface NoteFileRef {
  /** Full readable URI (file:// path or SAF content:// document URI). */
  uri: string;
  /** Basename, e.g. "my-idea.md". */
  name: string;
  /** Which note subdir it came from. */
  subdir: NoteSubdir;
}

/**
 * Enumerate every markdown note across the vault's note subdirs (Ideas,
 * Journal, People). Binaries (Photos/Audio/Files) are excluded. This is the
 * source the tag index scans — Recents (AsyncStorage, max 20) is a capture
 * history, NOT a vault scan, so it cannot back tag enumeration.
 */
export async function listNoteFiles(): Promise<NoteFileRef[]> {
  const root = await resolveRoot();
  const out: NoteFileRef[] = [];
  for (const subdir of NOTE_SUBDIRS) {
    const subdirUri = await root.fs.findOrCreateSubdir(root.uri, subdir);
    const entries = await root.fs.listChildren(subdirUri);
    for (const { uri, name } of entries) {
      if (name.toLowerCase().endsWith(".md")) {
        out.push({ uri, name, subdir });
      }
    }
  }
  return out;
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
  const archiveUri = await root.fs.findOrCreateSubdir(root.uri, "Archive");

  const content = await readByUri(filepath);

  // Build collision-free archive name for the .md. The URI's raw last path
  // segment is only the filename on file:// paths — a SAF document URI ends in
  // the URL-ENCODED document id (primary%3Acarnet%2FIdeas%2Fnote.md), which
  // used to archive verbatim as the display name (observed on-device
  // 2026-07-16). safLastSegment decodes SAF ids to the real filename.
  const mdName = filepath.startsWith("content://")
    ? safLastSegment(filepath)
    : (filepath.split("/").pop() ?? "note.md");
  const mdDot = mdName.lastIndexOf(".");
  const mdStem = mdDot >= 0 ? mdName.slice(0, mdDot) : mdName;
  const mdExt = mdDot >= 0 ? mdName.slice(mdDot) : ".md";
  const mdArchiveName = await findCollisionFreeName(
    archiveUri,
    mdStem,
    mdExt,
    root.fs,
  );
  const archivedMdPath = await writeNewFile(
    archiveUri,
    mdArchiveName,
    content,
    root.fs,
  );

  // Archive every paired binary referenced by the body (each resolvable one).
  // The filename class in PAIRED_BINARY_LINK rejects `/`, so a crafted
  // `[x](../Photos/../../secret)` link can't traverse out of the subdir — this
  // is defense-in-depth; today's writers emit slugified ASCII names.
  const archivedBinaryPaths: string[] = [];
  const binaryOriginals: string[] = [];
  for (const pb of listPairedBinaries(content)) {
    const subdirUri = await root.fs.findOrCreateSubdir(root.uri, pb.subdir);
    const binUri = await root.fs.findChild(subdirUri, pb.filename);
    if (!binUri) continue; // broken link — archive the .md, accept the orphan
    const binDot = pb.filename.lastIndexOf(".");
    const binStem = binDot >= 0 ? pb.filename.slice(0, binDot) : pb.filename;
    const binExt = binDot >= 0 ? pb.filename.slice(binDot) : "";
    const binArchiveName = await findCollisionFreeName(
      archiveUri,
      binStem,
      binExt,
      root.fs,
    );
    const binBase64 = await root.fs.readBinary(binUri);
    const archived = await writeBinaryBytes(
      archiveUri,
      binArchiveName,
      binBase64,
      root.fs,
    );
    archivedBinaryPaths.push(archived);
    binaryOriginals.push(binUri);
  }

  // Best-effort delete of the originals — see jsdoc.
  try {
    await root.fs.delete(filepath);
  } catch {
    /* leave the original; archive copy is canonical */
  }
  for (const orig of binaryOriginals) {
    try {
      await root.fs.delete(orig);
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
