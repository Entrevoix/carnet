/**
 * Pure helpers for LlmProviderSection's provider-picker and model-browser
 * wiring. Split out from llmProviderForm.ts (rather than added to it) so
 * neither this nor its test file touches a module another oracle test
 * relies on being untouched.
 */

import type { LlmProvider } from "./llmProviders";

/** Which identity id the open ProviderPickerModal is selecting for. `null`
 * means the modal is closed. */
export type PickerMode = "active" | "fallback" | "vision" | "enhance";

/**
 * Title and currently-selected id for the ProviderPickerModal, given which
 * role is open. A closed picker (`pickerMode === null`) still needs a value
 * to pass down before it's dismissed off-screen, so this resolves the same
 * "active" defaults the component used before extraction.
 */
export function resolvePickerPresentation(
  pickerMode: PickerMode | null,
  ids: {
    activeProviderId: string;
    fallbackProviderId: string | null;
    visionProviderId: string | null;
    enhanceProviderId: string | null;
  },
): { title: string; selectedId: string | null } {
  const titles: Record<PickerMode, string> = {
    active: "Choose LLM provider",
    fallback: "Offline fallback provider",
    vision: "Vision provider",
    enhance: "Enhance model",
  };
  const selected: Record<PickerMode, string | null> = {
    active: ids.activeProviderId,
    fallback: ids.fallbackProviderId,
    vision: ids.visionProviderId,
    enhance: ids.enhanceProviderId,
  };
  const mode = pickerMode ?? "active";
  return { title: titles[mode], selectedId: selected[mode] };
}

/**
 * Which provider's catalog/key the model browser should use for `target`.
 * Only "enhance" resolves to a different entry than the one open in the
 * editor: it browses against the RESOLVED enhance provider (enhanceProviderId
 * when set, else the active entry), not whichever entry the user merely has
 * open above — see LlmProviderSection's openBrowse for how the result is
 * used (src's saved baseUrl/key win over editBuffer's unsaved edits).
 */
export function resolveBrowseSource(
  target: "chat" | "vision" | "enhance",
  providerList: readonly LlmProvider[],
  enhanceProviderId: string | null,
  activeProviderId: string,
  active: LlmProvider,
): { src: LlmProvider | null; keyOwnerId: string } {
  const src =
    target === "enhance"
      ? providerList.find((p) => p.id === (enhanceProviderId ?? activeProviderId)) ?? active
      : null;
  const keyOwnerId = src ? src.id : active.id;
  return { src, keyOwnerId };
}
