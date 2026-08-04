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
 * Derive a short title from a captured note's markdown. Prefers the first H1;
 * otherwise returns the FIRST line truncated to 60 chars — which is `""` when
 * the body is empty or begins with a blank line.
 *
 * Returning `""` there is deliberate and load-bearing, not a gap: callers chain
 * a better fallback off the falsy value rather than accepting a placeholder
 * from here — `deriveTitle(body).trim() || stem` in `karakeepNoteExport`,
 * `deriveTitle(text) || "Idea"` in `notificationQuickIdea`. Substituting
 * something truthy here silently steals those fallbacks.
 */
export function deriveTitle(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) {
      return line.slice(2).trim();
    }
  }
  return markdown.split("\n", 1)[0]?.slice(0, 60) ?? "";
}
