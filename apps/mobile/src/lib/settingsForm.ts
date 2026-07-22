/**
 * Pure helpers for the Settings form, extracted from SettingsScreen so the
 * decidable-in-isolation pieces (Settings composition + capture-folder label)
 * have direct test coverage. The screen keeps its useState wiring and the
 * awaited IO (saveSettings, SecureStore key writes); these functions only
 * shape data.
 */

import {
  DEFAULT_LLM_BACKEND,
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  type PromptOverrides,
  type Settings,
} from "./settings";

/** Editable slice of {@link Settings} the Settings form renders. The API keys
 * are intentionally excluded — they live in SecureStore and are never read
 * into render state; only a "configured?" flag and a newly-typed replacement
 * are tracked by the screen. */
export interface FormState {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteVisionModel: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
}

/** The currently-stored API keys, threaded into the saved Settings so
 * saveSettings doesn't wipe any of them when only URL/model/folder changed.
 * localLlmApiKey is threaded through the same way (rather than added to
 * FormState) because Phase 1 has no local-LLM picker UI yet — see Task 6
 * (SettingsScreen.tsx) — so a save from this form must preserve whatever key
 * is already persisted instead of blanking it out. localLlmUrl/localLlmModel
 * are NOT part of this interface: they'll live on FormState once Task 5/6
 * add the picker UI, so composeSettingsForSave hardcodes them blank below in
 * the meantime, matching how llmBackend is hardcoded to the default. */
export interface ExistingApiKeys {
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}

/**
 * Compose the {@link Settings} object to persist from the form state and the
 * existing keys. Applies the blank→default fallbacks for the chat/vision
 * models and always persists the default backend (Phase 1 has no picker UI).
 * The keys are passed through unchanged: when the user typed a new key the
 * screen writes it separately via setOmniRouteApiKey/setKarakeepApiKey after
 * this save, and passing the existing (or empty) key here matches the prior
 * behavior where saveSettings preserves — or clears — the stored key.
 */
export function composeSettingsForSave(
  form: FormState,
  existing: ExistingApiKeys,
): Settings {
  return {
    omniRouteUrl: form.omniRouteUrl,
    omniRouteModel: form.omniRouteModel || DEFAULT_OMNIROUTE_MODEL,
    omniRouteVisionModel: form.omniRouteVisionModel || DEFAULT_VISION_MODEL,
    llmBackend: DEFAULT_LLM_BACKEND,
    // Hardcoded blank until Task 5 adds a FormState field + Task 6 adds
    // picker UI — mirrors how llmBackend: DEFAULT_LLM_BACKEND is hardcoded
    // above for the identical reason.
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: existing.localLlmApiKey,
    persistentNotificationEnabled: form.persistentNotificationEnabled,
    autoTranscribeOnSave: form.autoTranscribeOnSave,
    richEditorEnabled: form.richEditorEnabled,
    previewBeforeSave: form.previewBeforeSave,
    omniRouteApiKey: existing.omniRouteApiKey,
    captureFolderPath: form.captureFolderPath,
    promptOverrides: form.promptOverrides,
    karakeepUrl: form.karakeepUrl,
    karakeepApiKey: existing.karakeepApiKey,
  };
}

/**
 * Best-effort human-readable label for a `content://` tree URI. SAF URIs look
 * like `content://com.android.externalstorage.documents/tree/primary%3AObsidian%2FCarnet`
 * — show the decoded tail after `tree/` so the user sees `primary:Obsidian/Carnet`.
 * Plain filesystem paths and non-content URIs are returned unchanged.
 */
export function captureFolderLabel(raw: string): string {
  if (!raw) return "";
  if (!raw.startsWith("content://")) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    const idx = decoded.lastIndexOf("tree/");
    if (idx >= 0) return decoded.slice(idx + 5);
    return decoded;
  } catch {
    return raw;
  }
}
