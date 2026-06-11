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

/** Order-independent equality of two tag lists (treated as sets). */
export function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((tag) => seen.has(tag));
}

/**
 * Reattach edited tags onto a note's stashed frontmatter header during a detail
 * edit. When the tag set is unchanged from `originalTags`, the header is
 * returned BYTE-EXACT (so editing only the body never rewrites the frontmatter,
 * nor adds a `tags:` field to a note that never had one). Otherwise the tags are
 * written as a canonical inline flow array — creating the block/field if absent.
 *
 * `header` is a frontmatter-only string (e.g. from splitFrontmatter), or "" for
 * a note with no frontmatter.
 *
 * NOTE: the byte-exact guarantee is CONDITIONAL on the tag set being unchanged.
 * The first tag change canonicalizes the whole line (a hand-written
 * `tags: [My Tag]` becomes `tags: [my-tag]`), so pre-existing tags get
 * normalized as a side effect. That is intended — it de-fragments the vault.
 */
export function applyTagsToHeader(
  header: string,
  editTags: string[],
  originalTags: string[],
): string {
  if (sameTagSet(editTags, originalTags)) return header;
  return setFrontmatterTags(header, editTags);
}

/**
 * Parse a tag-field change into the tokens to commit as chips plus the trailing
 * partial that stays in the input. A separator (whitespace or comma) finalizes
 * every complete token before it; with no separator nothing is committed yet.
 * Pure so the TagInput entry behavior is testable without a renderer.
 *
 *   "wor"      → { committed: [],            trailing: "wor" }
 *   "work "    → { committed: ["work"],      trailing: "" }
 *   "a, b, c"  → { committed: ["a", "b"],    trailing: "c" }
 */
export function splitTagInput(text: string): { committed: string[]; trailing: string } {
  if (!/[,\s]/.test(text)) return { committed: [], trailing: text };
  const parts = text.split(/[,\s]+/);
  return { committed: parts.slice(0, -1), trailing: parts[parts.length - 1] ?? "" };
}
