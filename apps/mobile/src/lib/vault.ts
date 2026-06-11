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

import { getFrontmatterTags, normalizeTag } from "./frontmatter";
import { listNoteFiles, readNote } from "./writer";

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

  await mapWithConcurrency(files, SCAN_CONCURRENCY, async (file) => {
    let markdown: string;
    try {
      markdown = await readNote(file.uri);
    } catch {
      return; // unreadable note — skip rather than fail the whole scan
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
