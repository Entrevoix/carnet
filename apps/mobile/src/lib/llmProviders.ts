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
 * run). A totally unknown id — e.g. a dangling `activeProviderId` left
 * pointing at a custom entry the user since deleted — falls back to the
 * `omniroute` preset with a warning rather than throwing: a thrown generic
 * Error isn't an `isNotConfiguredError`, so the capture-error path would
 * treat a dangling reference as an opaque failure instead of the familiar
 * "not configured" banner. Falling back to omniroute (which naturally
 * raises not-configured itself when unconfigured) keeps that path sane.
 */
export function resolveActiveProvider(
  providers: readonly LlmProvider[],
  activeProviderId: string,
): LlmProvider {
  const found = providers.find((p) => p.id === activeProviderId);
  if (found) return found;
  const preset = PROVIDER_PRESETS.find((p) => p.id === activeProviderId);
  if (preset) return { ...preset };
  console.warn(
    `[llmProviders] Unknown provider id "${activeProviderId}" (dangling reference — e.g. a deleted custom entry) — falling back to omniroute.`,
  );
  const omniroute = providers.find((p) => p.id === "omniroute");
  if (omniroute) return omniroute;
  const omniroutePreset = PROVIDER_PRESETS.find((p) => p.id === "omniroute");
  // PROVIDER_PRESETS always contains "omniroute" — see the const above —
  // so this branch is unreachable, but TypeScript can't see that.
  if (!omniroutePreset) throw new Error("omniroute preset is missing");
  return { ...omniroutePreset };
}

/**
 * The vision-capable model id a provider entry effectively serves. Relais
 * is a special case: its preset (and any edited copy of it) always carries
 * `visionModel: ""` — one model covers text AND vision for that entry, so
 * its EFFECTIVE vision model is its `model` field, not its `visionModel`
 * field. Every other provider (OmniRoute, a cloud preset, a custom entry)
 * keeps chat/vision as two independent fields. Mirrors dispatcher.ts's
 * buildConfig, which applies this exact same relais special-case when
 * resolving a ProviderConfig — kept here too so resolution (this module) and
 * config-building (dispatcher.ts) never disagree about whether a given
 * provider "has vision".
 */
export function effectiveVisionModel(provider: LlmProvider): string {
  if (provider.id === "relais") return provider.model.trim();
  return provider.visionModel.trim();
}

/**
 * Resolve the provider that should serve a vision-bearing call:
 *   1. the active entry, if it has an effective vision model.
 *   2. else `visionProviderId`'s entry, if set and it has an effective
 *      vision model (the Phase 3 rung).
 *   3. else null, so callers keep today's "not configured" degrade.
 */
export function resolveVisionProvider(
  providers: readonly LlmProvider[],
  activeProviderId: string,
  visionProviderId: string | null = null,
): LlmProvider | null {
  const active = resolveActiveProvider(providers, activeProviderId);
  if (effectiveVisionModel(active)) return active;
  if (visionProviderId) {
    const found = providers.find((p) => p.id === visionProviderId);
    if (found && effectiveVisionModel(found)) return found;
  }
  return null;
}

/** Labels/URLs beyond this length are almost certainly pasted garbage, not
 * a real endpoint — capped so a fat-fingered paste can't wedge a multi-KB
 * string into the persisted settings blob (and, for baseUrl, into every
 * enrichment request's URL going forward). */
const MAX_LABEL_LENGTH = 60;
const MAX_BASE_URL_LENGTH = 2048;

/** Validation errors for a provider entry — empty array means valid. Checked
 * before a custom entry is saved/used, AND before an edit to any entry
 * (including a preset) is persisted — see LlmProviderSection.tsx's
 * saveEntry, which used to skip this call entirely and let something like
 * `javascript:alert(1)` persist as a "base URL". Presets are only invalid if
 * a user blanked the base URL out or typed something unparseable into it. */
export function validateProvider(provider: LlmProvider): string[] {
  const errors: string[] = [];
  const label = provider.label.trim();
  const baseUrl = provider.baseUrl.trim();

  if (!label) errors.push("Label is required");
  else if (label.length > MAX_LABEL_LENGTH) {
    errors.push(`Label must be ${MAX_LABEL_LENGTH} characters or fewer`);
  }

  if (!baseUrl) {
    errors.push("Base URL is required");
  } else if (baseUrl.length > MAX_BASE_URL_LENGTH) {
    errors.push(`Base URL must be ${MAX_BASE_URL_LENGTH} characters or fewer`);
  } else {
    // Any scheme other than http/https (javascript:, data:, file:, a bare
    // unparseable string) is rejected here — this is the ONLY structural
    // check on the field, so it must not be skippable via the edit path.
    let scheme: string | null = null;
    try {
      scheme = new URL(baseUrl).protocol;
    } catch {
      scheme = null;
    }
    if (scheme !== "http:" && scheme !== "https:") {
      errors.push("Base URL must be a valid http:// or https:// address");
    }
  }

  return errors;
}

/** Result of {@link addCustomProvider}: the new list, plus the counter value
 * the caller must persist as `Settings.nextCustomSeq` for the NEXT call. */
export interface AddCustomProviderResult {
  providers: LlmProvider[];
  nextCustomSeq: number;
}

/**
 * Append a new custom provider entry. The id is `custom-<nextCustomSeq>`.
 * `nextCustomSeq` MUST be a persisted, monotonically-increasing counter
 * (`Settings.nextCustomSeq`) — never derived from the surviving list. It is
 * a counter, not a UUID, because Hermes has no `crypto.randomUUID` (the same
 * constraint that forced `expo-crypto` for #86); it is persisted rather than
 * scanned-and-incremented because scanning the surviving list lets a deleted
 * id get reissued to a NEW entry while its old API key is still sitting in
 * SecureStore under that id's alias — a live key silently leaking to
 * whatever endpoint the reused id now points at. Returns new objects;
 * `providers` is untouched.
 */
export function addCustomProvider(
  providers: readonly LlmProvider[],
  nextCustomSeq: number,
  input: { label: string; baseUrl: string; model: string; visionModel: string },
): AddCustomProviderResult {
  const next: LlmProvider = {
    id: `custom-${nextCustomSeq}`,
    label: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    visionModel: input.visionModel,
    preset: null,
  };
  return { providers: [...providers, next], nextCustomSeq: nextCustomSeq + 1 };
}

/**
 * Remove a provider entry by id from the LIST only — this function is pure
 * and does not touch SecureStore. Presets cannot be removed — a preset id
 * matched here throws rather than silently no-op'ing, so a future caller
 * (the Phase 4 UI) fails loudly instead of shipping a dead delete button.
 * Returns a new array; `providers` is untouched.
 *
 * Callers MUST also delete the entry's stored key (its id is never reissued
 * — see addCustomProvider — but an orphaned key would otherwise linger in
 * SecureStore forever). Use providerKeys.removeProviderAndKey, which does
 * both, in the safe order (key first, then list entry).
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

/** Runtime shape check for one persisted `LlmProvider` entry — every field
 * must be present with the right primitive type. Used to validate a parsed
 * AsyncStorage blob before trusting it (a malformed or truncated blob must
 * never propagate a `.find`-shaped crash into a screen's mount effect). */
export function isLlmProvider(x: unknown): x is LlmProvider {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.baseUrl === "string" &&
    typeof o.model === "string" &&
    typeof o.visionModel === "string" &&
    (o.preset === null || typeof o.preset === "string")
  );
}

/** Runtime shape check for a persisted `llmProviders` array: must be a
 * non-empty array of valid entries. Empty is rejected too — a zero-entry
 * list has no `omniroute`/`relais` fallback target and silently strands any
 * `activeProviderId`, so it is treated the same as a missing/corrupt list
 * (caller falls back to {@link buildDefaultProviders}). */
export function isValidProviderList(x: unknown): x is LlmProvider[] {
  return Array.isArray(x) && x.length > 0 && x.every(isLlmProvider);
}
