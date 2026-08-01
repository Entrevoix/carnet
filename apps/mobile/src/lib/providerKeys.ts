/**
 * Per-provider LLM API key storage (Stage: LLM provider list, Phase 2 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md).
 *
 * API keys never touch AsyncStorage or the settings blob — hard constraint,
 * CLAUDE.md. This module is the only one that reads/writes SecureStore for
 * LLM provider keys.
 *
 * ALIAS MAP — deliberately deviates from the design spec's proposed
 * migration step 6 (re-file `carnet.omniroute.apikey` ->
 * `carnet.llm.key.omniroute`, `carnet.localllm.apikey` ->
 * `carnet.llm.key.relais`). That re-filing is NOT implemented here: a key
 * that never moves cannot be lost. `omniroute` and `relais` keep reading and
 * writing the SAME SecureStore keys `settings.ts` has always used for them
 * (`carnet_omniroute_api_key` / `carnet_local_llm_api_key`), so an existing
 * install's already-stored key survives Phase 2 untouched, with no
 * write-verify-delete migration dance that could be interrupted mid-flight.
 * Every other provider id — including every custom entry, which never had a
 * pre-existing key to preserve — uses the generic `carnet.llm.key.<id>`
 * namespace the spec describes.
 */

import * as SecureStore from "expo-secure-store";
import { removeProvider, type LlmProvider } from "./llmProviders";

/** Legacy aliases — MUST stay byte-identical to the constants in
 * settings.ts (OMNIROUTE_API_KEY, LOCAL_LLM_API_KEY). Do not rename.
 *
 * Built on a null-prototype object rather than `{}` — a plain object
 * literal inherits `Object.prototype`, so `LEGACY_KEY_ALIASES["toString"]`
 * (or `"constructor"`, `"hasOwnProperty"`, ...) would resolve to a
 * PROTOTYPE FUNCTION, not `undefined`, and the `??` fallback below would
 * never fire — silently storing a secret under a garbage alias. Unreachable
 * today (ids are only ever "omniroute"/"relais"/presets/`custom-<n>`), but
 * becomes reachable the moment a provider id is user-editable (Phase 4).
 * `Object.create(null)` has no prototype at all, so an unknown key genuinely
 * reads as `undefined`. */
const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    omniroute: "carnet_omniroute_api_key",
    relais: "carnet_local_llm_api_key",
  },
);

/** Provider ids are restricted to this charset — enforced here (not just at
 * creation) as defense in depth: a malformed id must fail loudly rather
 * than silently mapping to a weird or colliding SecureStore alias. */
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Resolve the SecureStore alias for a given provider id. */
function aliasFor(id: string): string {
  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(`Invalid LLM provider id "${id}"`);
  }
  return LEGACY_KEY_ALIASES[id] ?? `carnet.llm.key.${id}`;
}

/** Read a provider's API key. Returns "" when none is stored — mirrors the
 * existing `omniRouteApiKey`/`localLlmApiKey` read pattern in settings.ts. */
export async function getKey(id: string): Promise<string> {
  const value = await SecureStore.getItemAsync(aliasFor(id));
  return value ?? "";
}

/** Write a provider's API key. A blank/whitespace-only value deletes the
 * stored key instead of persisting noise — mirrors setOmniRouteApiKey. */
export async function setKey(id: string, value: string): Promise<void> {
  const alias = aliasFor(id);
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(alias, value.trim());
  } else {
    await SecureStore.deleteItemAsync(alias);
  }
}

/** Delete a provider's stored key outright. Called directly by
 * {@link removeProviderAndKey}; exported on its own too since a future
 * caller may need to clear a key without also dropping the list entry. */
export async function deleteKey(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(aliasFor(id));
}

/**
 * Remove a custom provider entry AND its stored key together, in the safe
 * order: the key is deleted FIRST, the list entry SECOND. If the app is
 * killed between the two steps, the result is an orphaned (harmless, unused)
 * list entry — never an orphaned credential that a future re-add could
 * reissue the id onto (see addCustomProvider's persisted-counter comment for
 * why id reuse itself is already ruled out; this ordering is the second,
 * independent guard: even a bug that DID reissue an id could never inherit a
 * key that's already gone).
 *
 * This is the only place `providerKeys.ts` calls into `llmProviders.ts` —
 * the IO/orchestration layer composing the pure list-removal helper.
 */
export async function removeProviderAndKey(
  providers: readonly LlmProvider[],
  id: string,
): Promise<LlmProvider[]> {
  await deleteKey(id);
  return removeProvider(providers, id);
}
