/**
 * Pure helpers for the Settings → LLM provider UI (Phase 4 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI").
 * `components/LlmProviderSection.tsx` owns all the IO (settings reads/
 * writes, SecureStore, health checks, model-catalog fetches); this module
 * only shapes data, so the decidable-in-isolation pieces get direct test
 * coverage — same split as settingsForm.ts / modelBrowser.ts.
 */

import { isAllowedPlaintextHost } from "./netAllowlist";
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
  /** Mirrors {@link LlmProvider.allowInsecureTransport} (#176) — the
   * cleartext-consent toggle's local, not-yet-saved value. Unlike the other
   * three text fields, this is a boolean the toggle writes directly rather
   * than a TextInput's onChangeText, but it follows the exact same "typed
   * but not saved until Save provider" lifecycle. */
  allowInsecureTransport: boolean;
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
    allowInsecureTransport: provider.allowInsecureTransport ?? false,
  };
}

/**
 * True when the cleartext-consent toggle (#176) is relevant for the base URL
 * currently in the edit buffer: it must be plain `http://`, AND not already
 * covered by the credential gate ({@link isAllowedPlaintextHost} — loopback/
 * RFC1918). An `https://` URL, or an `http://` URL the gate already allows
 * without consent, makes the toggle a no-op — showing it there would offer a
 * checkbox that does nothing, which is worse than not showing it. Blank/
 * unparseable URLs also resolve to `false` (nothing to consent to yet). */
export function shouldShowInsecureTransportToggle(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed.toLowerCase().startsWith("http://")) return false;
  return !isAllowedPlaintextHost(trimmed);
}

/**
 * Apply an {@link EditBuffer} onto the matching entry in `providers`,
 * returning a new array (`providers` is untouched). `id`/`preset` are never
 * touched by this function — only the editable fields move, including
 * `allowInsecureTransport` (#176), applied to every entry (preset or
 * custom) the same way baseUrl/model/visionModel already are. A preset
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
      allowInsecureTransport: buffer.allowInsecureTransport,
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

/** The identity ids a Settings blob carries alongside `llmProviders`
 * — grouped here because {@link reassignIdentityAfterDelete} must update them
 * all together in one persisted write (the non-negotiable from the Phase
 * 4 spec: a dangling id left behind by a delete is recoverable but wrong to
 * ship). */
export interface ProviderIdentity {
  activeProviderId: string;
  fallbackProviderId: string | null;
  visionProviderId: string | null;
  enhanceProviderId: string | null;
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
 *
 * Promoting the fallback into the active slot ALSO vacates the fallback
 * slot (sets it to `null`), even though the fallback entry itself still
 * exists in the list. This was a real bug, not just a style choice: leaving
 * `fallbackProviderId` pointing at the entry that is now ALSO
 * `activeProviderId` means the offline-fallback chain (dispatcher.ts) would
 * retry the exact same endpoint that just failed, and the Settings UI would
 * show a "configured" fallback that can structurally never fire (it can
 * never differ from the active entry it's supposed to back up).
 */
export function reassignIdentityAfterDelete(
  identity: ProviderIdentity,
  deletedId: string,
): ProviderIdentity {
  const fallbackProviderId =
    identity.fallbackProviderId === deletedId ? null : identity.fallbackProviderId;
  const visionProviderId =
    identity.visionProviderId === deletedId ? null : identity.visionProviderId;
  // Clears like the other two. resolveEnhanceProvider already degrades a stale
  // id to the active entry, so this is consistency rather than a crash guard —
  // but a Settings screen showing a deleted entry as the Enhance model is
  // exactly the "recoverable but wrong to ship" case above.
  const enhanceProviderId =
    identity.enhanceProviderId === deletedId ? null : identity.enhanceProviderId;

  if (identity.activeProviderId !== deletedId) {
    return {
      activeProviderId: identity.activeProviderId,
      fallbackProviderId,
      visionProviderId,
      enhanceProviderId,
    };
  }
  const activeProviderId = fallbackProviderId ?? "omniroute";
  // The fallback slot is vacated unconditionally here — whether it just got
  // promoted into `activeProviderId` or was already null, the result after
  // deleting the active entry is never a fallback that equals the new
  // active entry.
  return { activeProviderId, fallbackProviderId: null, visionProviderId, enhanceProviderId };
}
