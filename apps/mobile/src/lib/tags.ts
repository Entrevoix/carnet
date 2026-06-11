/**
 * Pure tag helpers shared by the capture UI (TagInput) and both write paths
 * (online confirmSave + offline processRow). Kept native-free so it is unit
 * testable and so the two write paths inject tags identically — the documented
 * footgun is patching one path and silently dropping metadata on the other.
 */
import { getFrontmatterTags, normalizeTag, setFrontmatterTags } from "./frontmatter";

const DEFAULT_SUGGESTION_LIMIT = 6;

/**
 * Add `raw` to `tags` (normalized + de-duped). Returns the SAME array reference
 * when the tag is empty or already present, so the caller can cheaply skip a
 * no-op update.
 */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (!tag || tags.includes(tag)) return tags;
  return [...tags, tag];
}

/**
 * Suggest known tags for `query`, excluding already-`chosen` ones: exact-prefix
 * matches first (preserving the count-sorted input order), then substring
 * matches, capped at `limit`. An empty query returns the most-used known tags.
 */
export function suggestionsFor(
  known: string[],
  query: string,
  chosen: string[],
  limit = DEFAULT_SUGGESTION_LIMIT,
): string[] {
  const chosenSet = new Set(chosen);
  const pool = known.filter((tag) => !chosenSet.has(tag));
  const q = normalizeTag(query);
  if (!q) return pool.slice(0, limit);
  const prefix = pool.filter((tag) => tag.startsWith(q));
  const substring = pool.filter((tag) => !tag.startsWith(q) && tag.includes(q));
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Merge user-entered `userTags` into a note's frontmatter, PRESERVING any tags
 * the enrichment LLM already emitted (setFrontmatterTags normalizes + dedupes).
 * A no-op (returns the markdown unchanged) when there are no user tags.
 */
export function mergeUserTags(markdown: string, userTags?: string[]): string {
  if (!userTags || userTags.length === 0) return markdown;
  return setFrontmatterTags(markdown, [...getFrontmatterTags(markdown), ...userTags]);
}
