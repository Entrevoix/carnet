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

/** Extract the last path segment (filename or subdir name) from a SAF URI.
 * SAF URIs look like `content://...document/primary%3Acarnet%2FIdeas%2Fmyidea.md`;
 * the filename is whatever follows the last `/` in the decoded path part. */
function safLastSegment(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const slash = decoded.lastIndexOf("/");
  return slash >= 0 ? decoded.slice(slash + 1) : decoded;
}

/** Find a child file in `parentUri` whose name matches, or null. */
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

/** Extract a YAML frontmatter field value. */
function extractFrontmatterField(markdown: string, field: string): string | null {
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

/** Strip frontmatter block, returning only the body. */
function stripFrontmatter(markdown: string): string {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return markdown;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return markdown;
  return afterFirst.slice(endIdx + 4).replace(/^\n+/, "");
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

  let filename = `${slug}.md`;
  let existing = await findFileInDir(ideasUri, filename, root.isSaf);
  let n = 2;
  while (existing && n < 100) {
    filename = `${slug}-${n}.md`;
    existing = await findFileInDir(ideasUri, filename, root.isSaf);
    n++;
  }
  if (existing) {
    throw new Error(`More than 99 ideas with slug "${slug}" — pick a more distinctive title`);
  }

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

  let filename = `${stem}.md`;
  let existing = await findFileInDir(peopleUri, filename, root.isSaf);
  let n = 2;
  while (existing && n < 100) {
    filename = `${stem}-${n}.md`;
    existing = await findFileInDir(peopleUri, filename, root.isSaf);
    n++;
  }
  if (existing) {
    throw new Error(
      `More than 99 contacts with stem "${stem}" — clean up duplicates first`,
    );
  }

  const filepath = await writeNewFile(peopleUri, filename, markdown, root.isSaf);
  return { filepath };
}

/** Read the raw string content of a note file. Supports both file:// and content:// URIs. */
export async function readNote(filepath: string): Promise<string> {
  return readByUri(filepath);
}

/** Overwrite a note file with new content. Supports both file:// and content:// URIs. */
export async function updateNote(filepath: string, markdown: string): Promise<void> {
  await writeByUri(filepath, markdown);
}
