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

/** Legacy aliases — MUST stay byte-identical to the constants in
 * settings.ts (OMNIROUTE_API_KEY, LOCAL_LLM_API_KEY). Do not rename. */
const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = {
  omniroute: "carnet_omniroute_api_key",
  relais: "carnet_local_llm_api_key",
};

/** Resolve the SecureStore alias for a given provider id. */
function aliasFor(id: string): string {
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

/** Delete a provider's stored key outright — used when a custom provider is
 * removed, so its key doesn't linger in SecureStore forever. */
export async function deleteKey(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(aliasFor(id));
}
