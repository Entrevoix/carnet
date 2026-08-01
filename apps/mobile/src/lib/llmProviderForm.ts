/**
 * Pure helpers for the Settings → LLM provider UI (Phase 4 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI").
 * `components/LlmProviderSection.tsx` owns all the IO (settings reads/
 * writes, SecureStore, health checks, model-catalog fetches); this module
 * only shapes data, so the decidable-in-isolation pieces get direct test
 * coverage — same split as settingsForm.ts / modelBrowser.ts.
 */

import type { LlmProvider } from "./llmProviders";

/** The editable text fields of one {@link LlmProvider}, held as local
 * "typed but not yet saved" state while the user edits the active entry —
 * mirrors the rest of Settings' pending-key pattern (a TextInput's value
 * only lands in the persisted provider list once the user taps Save). */
export interface EditBuffer {
  label: string;
  baseUrl: string;
  model: string;
  visionModel: string;
}

/** Seed an {@link EditBuffer} from a provider entry — the starting point
 * whenever the section switches which entry it's showing (initial load, or
 * after the active provider changes). */
export function editBufferFromProvider(provider: LlmProvider): EditBuffer {
  return {
    label: provider.label,
    baseUrl: provider.baseUrl,
    model: provider.model,
    visionModel: provider.visionModel,
  };
}

/**
 * Apply an {@link EditBuffer} onto the matching entry in `providers`,
 * returning a new array (`providers` is untouched). `id`/`preset` are never
 * touched by this function — only the editable text fields move. A preset
 * entry's label is NOT overwritten even if the buffer carries an edited
 * value: labels are only editable for custom entries (`preset === null`) —
 * the caller's UI hides the label field for a preset, but this function
 * enforces the same rule at the data layer so a bug in the UI can't rename a
 * preset out from under `PROVIDER_PRESETS`-keyed lookups elsewhere.
 */
export function applyEditBuffer(
  providers: readonly LlmProvider[],
  id: string,
  buffer: EditBuffer,
): LlmProvider[] {
  return providers.map((p) => {
    if (p.id !== id) return p;
    return {
      ...p,
      label: p.preset === null ? buffer.label : p.label,
      baseUrl: buffer.baseUrl,
      model: buffer.model,
      visionModel: buffer.visionModel,
    };
  });
}

/** Apply a model-browser pick to an {@link EditBuffer} for the given target
 * — the EditBuffer-shaped equivalent of modelBrowser.ts's applyPickedModel
 * (which operated on the old FormState's omniRoute* fields). */
export function applyPickedModelToBuffer(
  buffer: EditBuffer,
  target: "chat" | "vision",
  id: string,
): EditBuffer {
  return target === "vision" ? { ...buffer, visionModel: id } : { ...buffer, model: id };
}

/** The three identity ids a Settings blob carries alongside `llmProviders`
 * — grouped here because {@link reassignIdentityAfterDelete} must update all
 * three together in one persisted write (the non-negotiable from the Phase
 * 4 spec: a dangling id left behind by a delete is recoverable but wrong to
 * ship). */
export interface ProviderIdentity {
  activeProviderId: string;
  fallbackProviderId: string | null;
  visionProviderId: string | null;
}

/**
 * Compute the identity ids that should be persisted in the SAME write as a
 * provider deletion. `fallbackProviderId`/`visionProviderId` simply clear to
 * `null` when they pointed at the deleted entry — both already degrade
 * gracefully to "not configured" when null (see llmProviders.ts's
 * resolveVisionProvider and dispatcher.ts's fallback chain), so there is no
 * better id to reassign them to.
 *
 * `activeProviderId` is different: it must never be left dangling, because
 * a fresh install needs a serving provider at all times. If the deleted
 * entry WAS active, this reassigns to the (already-cleared) fallback when
 * one is configured, else to the "omniroute" preset — the same default
 * `resolveActiveProvider` falls back to for an unknown id, chosen here
 * deliberately (not left to that fallback path) so the transition is a
 * clean, silent reassignment rather than a console.warn'd dangling-reference
 * recovery.
 */
export function reassignIdentityAfterDelete(
  identity: ProviderIdentity,
  deletedId: string,
): ProviderIdentity {
  const fallbackProviderId =
    identity.fallbackProviderId === deletedId ? null : identity.fallbackProviderId;
  const visionProviderId =
    identity.visionProviderId === deletedId ? null : identity.visionProviderId;

  if (identity.activeProviderId !== deletedId) {
    return { activeProviderId: identity.activeProviderId, fallbackProviderId, visionProviderId };
  }
  const activeProviderId = fallbackProviderId ?? "omniroute";
  return { activeProviderId, fallbackProviderId, visionProviderId };
}
