/**
 * The LLM provider list (Stage: LLM provider list, Phase 2 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md).
 *
 * Every enrichment backend Carnet can talk to — Relais-on-loopback, a
 * self-hosted OmniRoute, or any OpenAI-compatible cloud provider — is one
 * entry in a flat list rather than a hardcoded field pair. This module is
 * pure: no IO, no SecureStore, no AsyncStorage. It only knows the shape of
 * an entry, the shipped preset table, and how to resolve/validate/add/remove
 * entries in that list. `settings.ts` owns persistence; `providerKeys.ts`
 * owns the per-entry API key; `dispatcher.ts` wires the two together into a
 * ProviderConfig for llmClient.ts.
 */

/** One configured LLM endpoint. Presets and custom entries share this shape. */
export interface LlmProvider {
  /** Stable id. Preset ids are fixed literals; custom ids are `custom-<n>`. */
  id: string;
  /** Display name. Editable for custom entries, fixed (but user-overridable
   * in a later phase) for presets. */
  label: string;
  /** OpenAI-compatible root, no trailing slash, no `/v1` suffix. */
  baseUrl: string;
  /** Chat/text model id. */
  model: string;
  /** Vision-capable model id; "" means this provider serves no vision calls. */
  visionModel: string;
  /** Which preset this came from; null for user-created entries. For a
   * preset entry this always equals `id` — kept as a separate field so the
   * only check anywhere is `preset === null` ("is this user-created?"),
   * rather than matching ids against the preset table. */
  preset: string | null;
}

/**
 * Shipped presets (base URLs only; the user supplies key and model, except
 * `relais` which needs neither to work out of the box). Ollama and LM Studio
 * are deliberately not presets — custom entries cover them.
 */
export const PROVIDER_PRESETS: readonly LlmProvider[] = [
  {
    id: "relais",
    label: "Relais (local)",
    baseUrl: "http://127.0.0.1:8080",
    model: "",
    visionModel: "",
    preset: "relais",
  },
  {
    id: "omniroute",
    label: "OmniRoute",
    baseUrl: "",
    model: "",
    visionModel: "",
    preset: "omniroute",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "",
    visionModel: "",
    preset: "openai",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    model: "",
    visionModel: "",
    preset: "groq",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "",
    visionModel: "",
    preset: "openrouter",
  },
];

/**
 * A fresh copy of the preset table (new array, new objects per entry) —
 * used whenever a caller needs a default `llmProviders` list, so nobody
 * accidentally mutates the shared `PROVIDER_PRESETS` constant.
 */
export function buildDefaultProviders(): LlmProvider[] {
  return PROVIDER_PRESETS.map((p) => ({ ...p }));
}

/**
 * Resolve `activeProviderId` to its {@link LlmProvider} entry. Falls back to
 * the matching preset (defensive — should not happen once migration has
 * run) and throws only if the id is unknown outright, mirroring the old
 * dispatcher's loud failure on an unrecognized backend.
 */
export function resolveActiveProvider(
  providers: readonly LlmProvider[],
  activeProviderId: string,
): LlmProvider {
  const found = providers.find((p) => p.id === activeProviderId);
  if (found) return found;
  const preset = PROVIDER_PRESETS.find((p) => p.id === activeProviderId);
  if (preset) return { ...preset };
  throw new Error(`Unknown LLM provider id "${activeProviderId}"`);
}

/**
 * Resolve the provider that should serve a vision-bearing call. Phase 2 has
 * no `visionProviderId` fallback rung yet (that lands in Phase 3) — this
 * only checks whether the active entry itself has a vision model, returning
 * null otherwise so callers keep today's "not configured" degrade.
 */
export function resolveVisionProvider(
  providers: readonly LlmProvider[],
  activeProviderId: string,
): LlmProvider | null {
  const active = resolveActiveProvider(providers, activeProviderId);
  return active.visionModel.trim() ? active : null;
}

/** Validation errors for a provider entry — empty array means valid. Checked
 * before a custom entry is saved/used; presets are only invalid if a user
 * blanked the base URL out. */
export function validateProvider(provider: LlmProvider): string[] {
  const errors: string[] = [];
  if (!provider.label.trim()) errors.push("Label is required");
  if (!provider.baseUrl.trim()) errors.push("Base URL is required");
  return errors;
}

/**
 * Append a new custom provider entry. The id is `custom-<n>`, where `n` is
 * one past the highest existing custom suffix — a counter, not a UUID,
 * because Hermes has no `crypto.randomUUID` (the same constraint that
 * forced `expo-crypto` for #86). Returns a new array; `providers` is
 * untouched.
 */
export function addCustomProvider(
  providers: readonly LlmProvider[],
  input: { label: string; baseUrl: string; model: string; visionModel: string },
): LlmProvider[] {
  const highest = providers.reduce((max, p) => {
    const m = /^custom-(\d+)$/.exec(p.id);
    if (!m) return max;
    const n = Number.parseInt(m[1], 10);
    return n > max ? n : max;
  }, 0);
  const next: LlmProvider = {
    id: `custom-${highest + 1}`,
    label: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    visionModel: input.visionModel,
    preset: null,
  };
  return [...providers, next];
}

/**
 * Remove a provider entry by id. Presets cannot be removed — a preset id
 * matched here throws rather than silently no-op'ing, so a future caller
 * (the Phase 4 UI) fails loudly instead of shipping a dead delete button.
 * Returns a new array; `providers` is untouched.
 */
export function removeProvider(
  providers: readonly LlmProvider[],
  id: string,
): LlmProvider[] {
  const target = providers.find((p) => p.id === id);
  if (!target) return [...providers];
  if (target.preset !== null) {
    throw new Error(`Cannot remove preset provider "${id}"`);
  }
  return providers.filter((p) => p.id !== id);
}
