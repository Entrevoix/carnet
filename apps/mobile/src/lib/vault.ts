/**
 * Vault tag index for carnet.
 *
 * Builds a tag → note index by scanning every markdown note's frontmatter
 * (listNoteFiles + getFrontmatterTags). Recents (AsyncStorage, max 20) is a
 * capture history, not a vault scan, so it cannot back tag autocomplete or the
 * tag browser — those need a real file enumeration, which is what this does.
 *
 * The scan is potentially slow on a large vault (one read per note), so it is
 * bounded-concurrency and the result is cached to AsyncStorage. Callers should
 * read the cache for instant render and refresh lazily (on focus / pull /
 * after a capture), not on every keystroke.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { deriveTitle } from "@carnet/shared";

import { extractFrontmatterField, getFrontmatterTags, normalizeTag } from "./frontmatter";
import { listNoteFiles, readNote } from "./writer";
import type { CaptureEntry, CaptureMode } from "./storage";

const CACHE_KEY = "carnet:tagindex:v1";

/** Max concurrent note reads during a scan — keeps SAF/IPC pressure bounded. */
const SCAN_CONCURRENCY = 8;

export interface TagIndexEntry {
  /** Normalized tag (see normalizeTag). */
  tag: string;
  /** Number of distinct notes carrying the tag. */
  count: number;
  /** URIs of the notes carrying the tag. */
  files: string[];
}

export interface TagIndex {
  /** Epoch ms the index was built — lets callers show staleness / decide refresh. */
  builtAt: number;
  /** Entries sorted by count desc, then tag asc. */
  tags: TagIndexEntry[];
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Scan the vault and build the tag index fresh (no cache read/write). Notes
 * that fail to read (deleted mid-scan, SAF permission revoked) or carry no
 * frontmatter are skipped. Tags are normalized; a tag counted once per note.
 */
export async function buildTagIndex(): Promise<TagIndex> {
  const files = await listNoteFiles();
  const tagToFiles = new Map<string, Set<string>>();
  let skipped = 0;

  await mapWithConcurrency(files, SCAN_CONCURRENCY, async (file) => {
    let markdown: string;
    try {
      markdown = await readNote(file.uri);
    } catch {
      skipped += 1; // unreadable (deleted mid-scan / perm revoked) — skip, don't fail
      return;
    }
    for (const raw of getFrontmatterTags(markdown)) {
      const tag = normalizeTag(raw);
      if (!tag) continue;
      let set = tagToFiles.get(tag);
      if (!set) {
        set = new Set<string>();
        tagToFiles.set(tag, set);
      }
      set.add(file.uri);
    }
  });

  if (skipped > 0) {
    console.warn(`[vault] tag index skipped ${skipped}/${files.length} unreadable note(s)`);
  }

  const tags: TagIndexEntry[] = [...tagToFiles.entries()]
    .map(([tag, set]) => ({ tag, count: set.size, files: [...set] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { builtAt: Date.now(), tags };
}

/** Read the cached index, or null when absent / corrupt. */
export async function loadCachedTagIndex(): Promise<TagIndex | null> {
  const raw = await AsyncStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TagIndex;
    if (parsed && typeof parsed.builtAt === "number" && Array.isArray(parsed.tags)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the index fresh and persist it to the cache. */
export async function refreshTagIndex(): Promise<TagIndex> {
  const index = await buildTagIndex();
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(index));
  return index;
}

/**
 * Drop the cached index so the next getTagIndex rebuilds from the vault. Call
 * (fire-and-forget) after any write that can change tags — a capture, an
 * offline drain, or a tag edit — so the browser counts and capture autocomplete
 * don't keep serving stale data for the rest of the session.
 */
export async function invalidateTagIndex(): Promise<void> {
  await AsyncStorage.removeItem(CACHE_KEY);
}

/**
 * Return the cached index immediately when present, else build + persist one.
 * For stale-while-revalidate, render this result and fire refreshTagIndex() in
 * the background.
 */
export async function getTagIndex(): Promise<TagIndex> {
  const cached = await loadCachedTagIndex();
  if (cached) return cached;
  return refreshTagIndex();
}

/** Just the distinct normalized tags carried by a note's markdown. */
export function tagsForNote(markdown: string): string[] {
  const seen = new Set<string>();
  for (const raw of getFrontmatterTags(markdown)) {
    const tag = normalizeTag(raw);
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * Autocomplete suggestions for a partial tag query against an index: exact
 * prefix matches first (alpha), then substring matches, capped at `limit`. An
 * empty query returns the most-used tags (index is already count-sorted).
 */
export function suggestTags(index: TagIndex, query: string, limit = 8): string[] {
  const all = index.tags.map((entry) => entry.tag);
  const q = normalizeTag(query);
  if (!q) return all.slice(0, limit);
  const prefix = all.filter((tag) => tag.startsWith(q));
  const substring = all.filter((tag) => !tag.startsWith(q) && tag.includes(q));
  return [...prefix, ...substring].slice(0, limit);
}

// ── Tag browser: notes for a tag ──────────────────────────────────────────────

/** Decoded basename of a note URI with the `.md` extension stripped. */
function basenameTitle(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const last = decoded.split("/").pop() ?? decoded;
  return last.replace(/\.md$/i, "");
}

/** Infer the capture mode from the note's IMMEDIATE parent subdir. We match the
 * parent segment (not a substring anywhere in the path) so a vault rooted under
 * a folder literally named "Journal"/"People" doesn't misclassify its Ideas. */
export function inferNoteMode(uri: string): CaptureMode {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const segments = decoded.split("/").filter(Boolean);
  const parent = segments[segments.length - 2];
  if (parent === "Journal") return "journal";
  if (parent === "People") return "person";
  return "idea";
}

/** Parse a `created:`/`date:` frontmatter value to epoch ms, or null. */
function frontmatterDateMs(markdown: string): number | null {
  const raw =
    extractFrontmatterField(markdown, "created") ?? extractFrontmatterField(markdown, "date");
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build a minimal CaptureEntry for a vault-scanned note that may not be in the
 * 20-item Recents history. Mode comes from the subdir, title from the H1 (else
 * the filename), createdAt from the frontmatter date (else 0). The id is
 * filepath-derived and deliberately NOT a recents id — RecentDetail's history
 * mutations (remove/updateTitle) no-op on unknown ids, so opening or deleting a
 * browsed note never corrupts the recents list.
 */
export function synthesizeEntry(uri: string, markdown: string): CaptureEntry {
  return {
    id: `vault:${uri}`,
    mode: inferNoteMode(uri),
    title: deriveTitle(markdown) || basenameTitle(uri),
    filepath: uri,
    createdAt: frontmatterDateMs(markdown) ?? 0,
  };
}

/**
 * Resolve the notes carrying `tag` into CaptureEntry rows (newest first), ready
 * to hand to RecentDetail. Reads each note (bounded concurrency); unreadable
 * notes are skipped.
 */
export async function notesForTag(index: TagIndex, tag: string): Promise<CaptureEntry[]> {
  const entry = index.tags.find((t) => t.tag === normalizeTag(tag));
  if (!entry) return [];
  const out: CaptureEntry[] = [];
  await mapWithConcurrency(entry.files, SCAN_CONCURRENCY, async (uri) => {
    let markdown: string;
    try {
      markdown = await readNote(uri);
    } catch {
      return;
    }
    out.push(synthesizeEntry(uri, markdown));
  });
  out.sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
  return out;
}
