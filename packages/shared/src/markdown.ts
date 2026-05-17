/**
 * Pure markdown helpers shared between mobile + desktop capture screens.
 * Environment-bound code (storage, networking) stays per-platform; this is
 * just string parsing.
 */

import type { IdeaStatus } from "./types";

export const IDEA_STATUSES: readonly IdeaStatus[] = [
  "seedling",
  "developing",
  "mature",
];

/**
 * Parse the `status:` frontmatter field. Tolerates optional double or single
 * quotes around the value (Claude sometimes adds them defensively even though
 * the prompt template doesn't).
 */
export function parseStatusFromMarkdown(markdown: string): IdeaStatus | null {
  const match = markdown.match(/^status:\s*['"]?(\w+)['"]?/m);
  const value = match?.[1];
  if (value === "seedling" || value === "developing" || value === "mature") {
    return value;
  }
  return null;
}

/**
 * Derive a short title from a captured note's markdown. Prefers the first
 * H1; falls back to the first non-empty line truncated to 60 chars.
 */
export function deriveTitle(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) {
      return line.slice(2).trim();
    }
  }
  return markdown.split("\n", 1)[0]?.slice(0, 60) ?? "Untitled";
}
