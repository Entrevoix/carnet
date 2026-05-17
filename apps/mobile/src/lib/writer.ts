/**
 * Local markdown writer for carnet v0.2.
 *
 * Writes notes to the local file system under the carnet folder
 * (default: ${FileSystem.documentDirectory}carnet/). Directory structure:
 *   Ideas/{slug}.md            — one file per idea
 *   Journal/YYYY-MM-DD.md      — daily journal, append-on-existing
 *   People/{Firstname-Lastname}.md — one file per contact
 *
 * Uses expo-file-system (legacy API) which is available in Expo 54 React Native.
 */

import * as FileSystem from "expo-file-system/legacy";

/** Returns the root carnet folder URI (trailing slash). */
function carnetRoot(): string {
  const base = FileSystem.documentDirectory ?? "file:///data/user/0/carnet/files/";
  return `${base.replace(/\/$/, "")}/carnet`;
}

async function ensureDir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
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
 */
export function personFilename(name: string): string {
  const cleaned = name
    .split("")
    .filter((c) => /[a-zA-Z0-9\s\-']/.test(c))
    .join("");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts.join("-");
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write an idea note. Slug is derived from the markdown H1.
 * Handles collision by appending -2, -3, etc. up to -99.
 */
export async function writeIdea(
  slug: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = carnetRoot();
  const dir = `${root}/Ideas`;
  await ensureDir(dir);

  let filepath = `${dir}/${slug}.md`;
  let info = await FileSystem.getInfoAsync(filepath);
  let n = 2;
  while (info.exists && n < 100) {
    filepath = `${dir}/${slug}-${n}.md`;
    info = await FileSystem.getInfoAsync(filepath);
    n++;
  }
  if (info.exists) {
    throw new Error(`More than 99 ideas with slug "${slug}" — pick a more distinctive title`);
  }

  await FileSystem.writeAsStringAsync(filepath, markdown, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return { filepath };
}

/**
 * Append a journal entry to today's file. If the file already exists, the new
 * entry's body (frontmatter stripped) is appended under a `## HH:MM` heading.
 */
export async function appendJournal(
  date: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = carnetRoot();
  const dir = `${root}/Journal`;
  await ensureDir(dir);

  const filepath = `${dir}/${date}.md`;
  const info = await FileSystem.getInfoAsync(filepath);

  let finalMarkdown: string;
  if (info.exists) {
    const existing = await FileSystem.readAsStringAsync(filepath, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const appended = stripFrontmatter(markdown);
    finalMarkdown = `${existing.trimEnd()}\n\n## ${hhmm}\n\n${appended.trimStart()}`;
  } else {
    finalMarkdown = markdown;
  }

  await FileSystem.writeAsStringAsync(filepath, finalMarkdown, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return { filepath };
}

/**
 * Write a person (contact) note. Filename derived from the `name:` frontmatter
 * field or the H1 title. Overwrites if file already exists (same person
 * captured twice is an update, not a collision).
 */
export async function writePerson(
  firstName: string,
  lastName: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = carnetRoot();
  const dir = `${root}/People`;
  await ensureDir(dir);

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

  const filepath = `${dir}/${stem}.md`;
  await FileSystem.writeAsStringAsync(filepath, markdown, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return { filepath };
}

/** Read the raw string content of a note file. */
export async function readNote(filepath: string): Promise<string> {
  return FileSystem.readAsStringAsync(filepath, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** Overwrite a note file with new content. */
export async function updateNote(filepath: string, markdown: string): Promise<void> {
  await FileSystem.writeAsStringAsync(filepath, markdown, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}
