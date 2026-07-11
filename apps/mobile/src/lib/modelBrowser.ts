/**
 * Pure filtering/partitioning for the Settings model browser. Extracted from
 * SettingsScreen so the recommended-vs-others split has direct test coverage
 * (it drives which models a user sees when picking a chat/vision model).
 */

export interface SplitModels {
  /** Recommended models present in the (filtered) catalog, in the order of the
   * supplied `recommended` list — NOT catalog order. */
  recommended: string[];
  /** Everything else in the (filtered) catalog that isn't a recommended model. */
  others: string[];
}

/**
 * Filter `models` by `filter` (case-insensitive substring, trimmed) and split
 * the matches into recommended vs the rest. A null catalog (not yet fetched)
 * yields empty partitions. A blank/whitespace-only filter matches everything.
 */
export function filterAndSplitModels(
  models: readonly string[] | null,
  filter: string,
  recommended: readonly string[],
): SplitModels {
  if (!models) return { recommended: [], others: [] };
  const q = filter.trim().toLowerCase();
  const matches = q
    ? models.filter((m) => m.toLowerCase().includes(q))
    : models;
  const recSet = new Set<string>(recommended);
  const rec = recommended.filter((m) => matches.includes(m));
  const rest = matches.filter((m) => !recSet.has(m));
  return { recommended: [...rec], others: [...rest] };
}
