/**
 * Pure filtering/partitioning for the Settings model browser. Extracted from
 * SettingsScreen so the recommended-vs-others split has direct test coverage
 * (it drives which models a user sees when picking a chat/vision model).
 */

/**
 * Pinned at the top of the model browser. Verified-working chat models on
 * llm.grepon.cc for carnet's structured-markdown use case — the catalog also
 * contains embeddings, image gen, and broken upstream routes the user has no
 * reason to click. Order is rough quality/cost tradeoff. Used for every
 * provider's model browser (components/LlmProviderSection.tsx) — the list
 * happens to be llm.grepon.cc-flavored model ids, which is harmless noise for
 * a provider whose catalog doesn't contain them (they simply never match
 * "recommended" and fall into "others").
 */
export const RECOMMENDED_MODELS = [
  "gemini/gemini-2.5-flash-lite",
  "gemini/gemini-2.5-flash",
  "claude/claude-haiku-4-5-20251001",
  "claude/claude-sonnet-4-6",
] as const;

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
 *
 * Repeated catalog ids are collapsed to their first occurrence. This is not
 * tidiness: the browser renders `others` in a FlatList keyed on the model id
 * (components/ModelBrowserModal.tsx), so a repeated id is a duplicate React key
 * and the list remounts cells and pulses instead of settling. Real gateways do
 * serve repeats (llm.grepon.cc has, in practice), and filtering is what
 * surfaces it, by collapsing the catalog until both copies of a pair sit in one
 * viewport.
 *
 * Collapsing is safe because the id is the ENTIRE identity carried downstream:
 * applyPickedModel stores just this string and llmClient sends it verbatim as
 * `model`, so two catalog rows sharing an id are indistinguishable to carnet no
 * matter how their other fields (capabilities, context_length, owned_by) differ
 * — the gateway, not us, resolves which backend serves it. If the browser ever
 * surfaces per-model metadata, revisit: first-occurrence-wins stops being free
 * the moment we render anything but the id.
 */
export function filterAndSplitModels(
  models: readonly string[] | null,
  filter: string,
  recommended: readonly string[],
): SplitModels {
  if (!models) return { recommended: [], others: [] };
  const q = filter.trim().toLowerCase();
  const matched = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  const matches = [...new Set<string>(matched)];
  const matchSet = new Set<string>(matches);
  const recSet = new Set<string>(recommended);
  const rec = recommended.filter((m) => matchSet.has(m));
  const rest = matches.filter((m) => !recSet.has(m));
  return { recommended: [...rec], others: [...rest] };
}

/**
 * Which API key to use for the model-browser catalog fetch: a freshly-typed,
 * not-yet-saved `pendingKey` takes priority over the stored one, so Browse
 * reflects a key the user just typed without requiring a Save first.
 */
export function resolveBrowseApiKey(pendingKey: string, storedKey: string): string {
  return pendingKey.length > 0 ? pendingKey : storedKey;
}
