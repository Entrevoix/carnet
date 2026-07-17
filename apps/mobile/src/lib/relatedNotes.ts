/**
 * Lexical related-notes scoring over the cached note index (PURE — no I/O).
 *
 * Surfaces "you've thought about this before" links in RecentDetail without
 * embeddings or network: the most-adopted AI-note feature is related-note
 * surfacing, and users want it additive and local (2026-07-17 market
 * research, rec #3). Deliberately cheap — shared tags + term overlap over
 * `carnet:noteindex:v1`'s title/excerpt fields — so it runs on every note
 * open with zero infrastructure. If this ever graduates to embeddings, only
 * this module changes.
 */

import type { NoteIndex, NoteIndexEntry } from "./vault";

/** How many related notes RecentDetail shows. */
export const RELATED_NOTES_LIMIT = 3;

/** Term weights. Tags are user/LLM-curated signal; title terms beat excerpt
 * terms because excerpts are noisy prose. */
const TAG_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const EXCERPT_WEIGHT = 1;

/** Minimum term length — a language-neutral stand-in for a stopword list
 * ("the", "and", "une", "les" all fall under it; real subject words rarely
 * do). Applied after lowercasing + punctuation stripping. */
const MIN_TERM_LENGTH = 4;

/** Tokenize prose into distinct significant terms. */
export function significantTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= MIN_TERM_LENGTH) out.add(raw);
  }
  return out;
}

/** What the scorer needs to know about the note currently being viewed. */
export interface RelatedQuery {
  /** The open note's URI — excluded from results. */
  uri: string;
  /** The open note's subdir, sharpening the identity fallback below. The
   * query URI comes from the WRITE path (createFileAsync's return, kept in
   * recents history) while index URIs come from the LISTING path — on SAF
   * those are not guaranteed byte-identical, and an encoding mismatch would
   * make the open note its own top "related" hit (it matches its own title
   * and tags by construction). Both URIs' DECODED basenames are compared as
   * the fallback; when `subdir` is provided a same-named note in a different
   * subdir is not falsely excluded. */
  subdir?: string;
  title: string;
  /** Normalized tags (tagsForNote's output). */
  tags: readonly string[];
}

/** Decoded last path segment of a note URI — SAF document ids URL-encode the
 * whole relative path, so a plain split("/") returns the encoded id. */
function uriBasename(uri: string): string {
  const docMarker = uri.indexOf("/document/");
  if (docMarker >= 0) {
    let decoded = uri.slice(docMarker + "/document/".length);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // keep the encoded form — still stable for equality checks
    }
    return decoded.slice(decoded.lastIndexOf("/") + 1);
  }
  return uri.slice(uri.lastIndexOf("/") + 1);
}

/** True when an index entry IS the note being viewed, robust to the two URI
 * sources disagreeing on percent-encoding. */
function isSelf(query: RelatedQuery, entry: NoteIndexEntry): boolean {
  if (entry.uri === query.uri) return true;
  if (query.subdir !== undefined && query.subdir !== entry.subdir) return false;
  return uriBasename(entry.uri) === uriBasename(query.uri);
}

/**
 * Score every other indexed note against the open one and return the top
 * matches (score desc, recency tiebreak). Zero-score notes never appear —
 * an empty result means "show nothing", not "show the newest notes".
 */
export function findRelatedNotes(
  query: RelatedQuery,
  index: NoteIndex,
  limit: number = RELATED_NOTES_LIMIT,
): NoteIndexEntry[] {
  const queryTags = new Set(query.tags);
  const queryTitleTerms = significantTerms(query.title);

  const scored: { entry: NoteIndexEntry; score: number }[] = [];
  for (const entry of index.notes) {
    if (isSelf(query, entry)) continue;

    let score = 0;
    for (const tag of entry.tags) {
      if (queryTags.has(tag)) score += TAG_WEIGHT;
    }
    const entryTitleTerms = significantTerms(entry.title);
    for (const term of entryTitleTerms) {
      if (queryTitleTerms.has(term)) score += TITLE_WEIGHT;
    }
    const excerptTerms = significantTerms(entry.excerpt ?? "");
    for (const term of excerptTerms) {
      // Only count excerpt terms not already credited via the title, so a
      // title word repeated in the excerpt isn't double-scored.
      if (queryTitleTerms.has(term) && !entryTitleTerms.has(term)) {
        score += EXCERPT_WEIGHT;
      }
    }

    if (score > 0) scored.push({ entry, score });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.createdOrDate - a.entry.createdOrDate,
    )
    .slice(0, limit)
    .map((s) => s.entry);
}
