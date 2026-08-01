/**
 * Pure helpers for the Settings form, extracted from SettingsScreen so the
 * decidable-in-isolation pieces (Settings composition + capture-folder label)
 * have direct test coverage. The screen keeps its useState wiring and the
 * awaited IO (saveSettings, SecureStore key writes); these functions only
 * shape data.
 */

import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  type PromptOverrides,
  type Settings,
} from "./settings";
import { resolveActiveProvider, type LlmProvider } from "./llmProviders";

/** The two providers the current (pre-Phase-4) Settings UI exposes a picker
 * for. The full provider list may hold more entries (other presets, custom
 * ones) — those pass through composeSettingsForSave untouched. */
export type FormLlmBackend = "omniroute" | "local";

/** Editable slice of {@link Settings} the Settings form renders. The API keys
 * are intentionally excluded — they live in SecureStore and are never read
 * into render state; only a "configured?" flag and a newly-typed replacement
 * are tracked by the screen. */
export interface FormState {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteVisionModel: string;
  llmBackend: FormLlmBackend;
  localLlmUrl: string;
  localLlmModel: string;
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
 * FormState) because it is a secret and lives in SecureStore, never in render
 * state. localLlmUrl/localLlmModel are NOT part of this interface: they live
 * on FormState as plain-text config fields and are passed through by
 * composeSettingsForSave. */
export interface ExistingApiKeys {
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}

/**
 * Compose the {@link Settings} object to persist from the form state, the
 * existing keys, and the provider list as it stood before this save.
 * Applies the blank→default fallbacks for the chat/vision models and
 * passes through the user's selected llmBackend and local-LLM
 * configuration by updating the `omniroute`/`relais` entries in
 * `currentProviders` — every other entry (other presets, custom providers;
 * this form has no UI for them yet) passes through unchanged. The keys are
 * passed through unchanged: when the user typed a new key the screen writes
 * it separately via setOmniRouteApiKey/setKarakeepApiKey after this save,
 * and passing the existing (or empty) key here matches the prior behavior
 * where saveSettings preserves — or clears — the stored key.
 *
 * `nextCustomSeq` is threaded straight through unchanged — this form has no
 * UI for adding custom providers yet (Phase 4), so nothing here ever
 * advances the counter; it just must not be dropped on save. `fallbackProviderId`
 * and `visionProviderId` are threaded through the same way — this form
 * predates the Phase 4 fallback/vision selectors, so nothing here ever
 * changes them; they just must not be dropped on save.
 */
export function composeSettingsForSave(
  form: FormState,
  existing: ExistingApiKeys,
  currentProviders: readonly LlmProvider[],
  nextCustomSeq: number,
  fallbackProviderId: string | null = null,
  visionProviderId: string | null = null,
): Settings {
  const omniRouteModel = form.omniRouteModel || DEFAULT_OMNIROUTE_MODEL;
  const omniRouteVisionModel = form.omniRouteVisionModel || DEFAULT_VISION_MODEL;
  const llmProviders = currentProviders.map((p) => {
    if (p.id === "omniroute") {
      return {
        ...p,
        baseUrl: form.omniRouteUrl,
        model: omniRouteModel,
        visionModel: omniRouteVisionModel,
      };
    }
    if (p.id === "relais") {
      return { ...p, baseUrl: form.localLlmUrl, model: form.localLlmModel };
    }
    return p;
  });
  return {
    llmProviders,
    activeProviderId: form.llmBackend === "local" ? "relais" : "omniroute",
    nextCustomSeq,
    fallbackProviderId,
    visionProviderId,
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
 * Builds the initial {@link FormState} from a loaded {@link Settings} plus
 * the (already-reconciled) notification toggle value. The inverse of
 * {@link composeSettingsForSave}'s field-by-field mapping — kept separate
 * because the notification field can't be read straight off `s` (it goes
 * through native-state reconciliation first).
 */
export function formStateFromSettings(
  s: Settings,
  persistentNotificationEnabled: boolean,
): FormState {
  const omniroute = resolveActiveProvider(s.llmProviders, "omniroute");
  const relais = resolveActiveProvider(s.llmProviders, "relais");
  return {
    omniRouteUrl: omniroute.baseUrl,
    omniRouteModel: omniroute.model,
    omniRouteVisionModel: omniroute.visionModel,
    llmBackend: s.activeProviderId === "relais" ? "local" : "omniroute",
    localLlmUrl: relais.baseUrl,
    localLlmModel: relais.model,
    persistentNotificationEnabled,
    autoTranscribeOnSave: s.autoTranscribeOnSave,
    richEditorEnabled: s.richEditorEnabled,
    previewBeforeSave: s.previewBeforeSave,
    captureFolderPath: s.captureFolderPath,
    promptOverrides: s.promptOverrides,
    karakeepUrl: s.karakeepUrl,
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

/**
 * Formats a caught error into a short, user-facing message: "<prefix>: <message>",
 * truncating the underlying message to 120 chars so it stays readable in a
 * Snackbar. Shared by every catch block on the Settings screen that surfaces
 * a failure this way (save, clear-key, folder picker, notification toggle).
 */
export function errorMessage(e: unknown, prefix: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `${prefix}: ${msg.slice(0, 120)}`;
}

/**
 * Extracts the currently-stored API keys from a loaded {@link Settings},
 * defaulting missing/undefined keys to "" — the {@link ExistingApiKeys} shape
 * `composeSettingsForSave` needs so a save that doesn't touch a given key
 * doesn't wipe it.
 */
export function existingApiKeysFromSettings(s: Settings): ExistingApiKeys {
  return {
    omniRouteApiKey: s.omniRouteApiKey ?? "",
    karakeepApiKey: s.karakeepApiKey ?? "",
    localLlmApiKey: s.localLlmApiKey ?? "",
  };
}

/**
 * Label for a secret-key TextInput: shows "(configured)" only when a key is
 * already stored AND the user hasn't started typing a replacement.
 */
export function apiKeyFieldLabel(
  baseLabel: string,
  configured: boolean,
  pendingLength: number,
): string {
  return configured && pendingLength === 0
    ? `${baseLabel} (configured)`
    : baseLabel;
}

/**
 * Placeholder for a secret-key TextInput: the "already configured" hint when
 * a key is stored, otherwise the caller-supplied blank-state hint.
 */
export function apiKeyFieldPlaceholder(
  configured: boolean,
  blankPlaceholder: string,
): string {
  return configured ? "•••• configured — tap to replace" : blankPlaceholder;
}
