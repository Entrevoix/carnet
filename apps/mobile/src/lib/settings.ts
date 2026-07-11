import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const SETTINGS_KEY = "carnet:settings:v2";
/** Legacy key — read once for migration, then ignored. */
const SETTINGS_KEY_V1 = "carnet:settings:v1";
/** Legacy SecureStore key from v0.1's navetted HMAC token. Purged on first
 * v0.2 settings load — see purgeLegacySecretsOnce(). */
const LEGACY_NAVETTED_TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
const KARAKEEP_API_KEY = "carnet_karakeep_api_key";
const WHISPER_API_KEY = "carnet_whisper_api_key";
/** Flag: user dismissed the navetted→OmniRoute migration banner. */
const MIGRATION_BANNER_KEY = "carnet:migration_banner_dismissed:v1";
/** Flag: legacy SecureStore secrets purged. Set to "1" after the one-time
 * unconditional sweep so we don't hit SecureStore on every getSettings(). */
const LEGACY_PURGE_KEY = "carnet:legacy_purge:v1";

export const DEFAULT_OMNIROUTE_MODEL = "openrouter/openai/gpt-4o-mini";
/** Default vision model — used for image-bearing enrichment (share-target
 * photos). Held separately from omniRouteModel (the chat/text model) so a
 * text-only chat model can never silently eat image parts and return a
 * confidently-wrong "enrichment". Defaults to a known vision-capable model. */
export const DEFAULT_VISION_MODEL = "openrouter/openai/gpt-4o-mini";

/** Default Whisper-compatible transcription endpoint (OpenAI's). Used when
 * the user hasn't overridden it — e.g. a self-hosted Whisper server. */
export const DEFAULT_WHISPER_ENDPOINT =
  "https://api.openai.com/v1/audio/transcriptions";

/**
 * Enrichment backend selector (Stage 2 / branch B7). `"omniroute"` is the
 * shipped default and the only backend wired in Phase 1; `"on-device"` is
 * reserved for the pluggable local-inference backend (native module + model
 * download, later phases). Persisted as a plain string in the AsyncStorage
 * settings blob — non-secret, so old blobs without the key take the default
 * via the `{...DEFAULT_PERSISTED, ...parsed}` spread in readPersisted.
 */
export type LlmBackend = "omniroute" | "on-device";

/** Default backend — the shipped OmniRoute client. */
export const DEFAULT_LLM_BACKEND: LlmBackend = "omniroute";

/**
 * Per-capture-mode system prompt overrides. Empty/missing fields fall back
 * to the defaults in `prompts.ts`. Whitespace-only values are sanitised to
 * empty on write so a stray accidental edit doesn't strand a noise override.
 */
export interface PromptOverrides {
  idea?: string;
  journal?: string;
  person?: string;
  sharedImage?: string;
  sharedLink?: string;
}

export interface Settings {
  omniRouteUrl: string;
  omniRouteApiKey: string;
  omniRouteModel: string;
  /** Vision-capable model for image-bearing enrichment (share-target photos).
   * Held separately from omniRouteModel (the chat/text model) so swapping the
   * chat model can't misroute image parts to a text-only model. Repurposed
   * from the vestigial transcription-model field (transcription is on-device
   * now via Whisper, so that config was dead). */
  omniRouteVisionModel: string;
  /** Which enrichment backend serves captures. Default `"omniroute"`; the
   * dispatcher (dispatcher.ts) routes on this. Only `"omniroute"` is wired in
   * Phase 1 — see {@link LlmBackend}. */
  llmBackend: LlmBackend;
  /** JS-side hint for the Settings UI's initial render — avoids a Switch
   * flicker before the async native read resolves. Source of truth lives
   * in native SharedPreferences (BootReceiver reads it directly). Whenever
   * these two diverge, native wins; SettingsScreen reconciles on mount. */
  persistentNotificationEnabled: boolean;
  /** When true, audio captures auto-run Whisper transcription after save.
   * Default false — doubles OmniRoute API spend per capture, so opt-in. */
  autoTranscribeOnSave: boolean;
  /** When true, RecentDetail note editing uses the experimental WYSIWYG (TenTap)
   * editor instead of the markdown TextInput + toolbar. Default false — off
   * until on-device round-trip fidelity is signed off. */
  richEditorEnabled: boolean;
  /**
   * When true, Idea captures restore the old blocking flow: enrich → preview →
   * Save tap → write. Default false, i.e. save-first is the default — the raw
   * note is written immediately and enrichment updates it in place afterwards.
   * Person always previews and ignores this flag; Journal is unaffected (it
   * stays on the deferred-write model this branch does not change).
   */
  previewBeforeSave: boolean;
  /**
   * Root folder for captured notes. Defaults to the app sandbox carnet/ dir.
   * Set to a Syncthing-watched folder for automatic sync to workstation.
   */
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  /** Self-hosted Karakeep instance URL (e.g. https://karakeep.example.com).
   * The `/api/v1` suffix is appended by the client. Blank = export disabled. */
  karakeepUrl: string;
  /** Karakeep API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob — mirrors omniRouteApiKey. */
  karakeepApiKey: string;
  /** Whisper-compatible transcription endpoint. Non-secret — persisted
   * alongside the rest of the settings blob. Defaults to OpenAI's endpoint
   * when blank. */
  whisperEndpoint: string;
  /** Whisper API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob — mirrors omniRouteApiKey/karakeepApiKey. */
  whisperApiKey: string;
}

interface PersistedSettings {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteVisionModel: string;
  llmBackend: LlmBackend;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
  whisperEndpoint: string;
}

/** Shape of a v1 settings blob — used for one-time migration read. */
interface LegacyPersistedSettings {
  navettedUrl?: string;
  omniRouteUrl?: string;
  captureFolderPath?: string;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  omniRouteUrl: "",
  omniRouteModel: DEFAULT_OMNIROUTE_MODEL,
  omniRouteVisionModel: DEFAULT_VISION_MODEL,
  llmBackend: DEFAULT_LLM_BACKEND,
  persistentNotificationEnabled: false,
  autoTranscribeOnSave: false,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "",
  promptOverrides: {},
  karakeepUrl: "",
  whisperEndpoint: "",
};

/** Strip whitespace-only entries so a `{idea: "   "}` save doesn't strand
 * noise in storage that downstream code would treat as a real override. */
function sanitisePromptOverrides(raw: PromptOverrides | undefined): PromptOverrides {
  if (!raw) return {};
  const out: PromptOverrides = {};
  (Object.keys(raw) as Array<keyof PromptOverrides>).forEach((k) => {
    const v = raw[k]?.trim();
    if (v) out[k] = v;
  });
  return out;
}

async function readPersisted(): Promise<PersistedSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      return {
        ...DEFAULT_PERSISTED,
        ...parsed,
        promptOverrides: sanitisePromptOverrides(parsed.promptOverrides),
      };
    } catch {
      return { ...DEFAULT_PERSISTED };
    }
  }

  // Try migrating from v1 blob
  const rawV1 = await AsyncStorage.getItem(SETTINGS_KEY_V1);
  if (rawV1) {
    try {
      const legacy = JSON.parse(rawV1) as LegacyPersistedSettings;
      return {
        omniRouteUrl: legacy.omniRouteUrl ?? "",
        omniRouteModel: DEFAULT_OMNIROUTE_MODEL,
        omniRouteVisionModel: DEFAULT_VISION_MODEL,
        llmBackend: DEFAULT_LLM_BACKEND,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: legacy.captureFolderPath ?? "",
        promptOverrides: {},
        karakeepUrl: "",
        whisperEndpoint: "",
      };
    } catch {
      return { ...DEFAULT_PERSISTED };
    }
  }

  return { ...DEFAULT_PERSISTED };
}

async function writePersisted(settings: PersistedSettings): Promise<void> {
  const sanitised: PersistedSettings = {
    omniRouteUrl: settings.omniRouteUrl,
    omniRouteModel: settings.omniRouteModel,
    omniRouteVisionModel: settings.omniRouteVisionModel,
    llmBackend: settings.llmBackend,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: sanitisePromptOverrides(settings.promptOverrides),
    karakeepUrl: settings.karakeepUrl,
    whisperEndpoint: settings.whisperEndpoint,
  };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitised));
}

/**
 * One-time unconditional sweep of legacy SecureStore secrets. Runs the first
 * time v0.2 boots after an upgrade. Catches the case where a user upgraded
 * past the migration banner without dismissing it (e.g. fresh install with
 * leftover keychain entries from a prior install).
 */
async function purgeLegacySecretsOnce(): Promise<void> {
  const done = await AsyncStorage.getItem(LEGACY_PURGE_KEY);
  if (done) return;
  try {
    await SecureStore.deleteItemAsync(LEGACY_NAVETTED_TOKEN_KEY);
  } catch {
    // SecureStore can throw on platforms without keychain access — best-effort
  }
  await AsyncStorage.setItem(LEGACY_PURGE_KEY, "1");
}

export async function getSettings(): Promise<Settings> {
  await purgeLegacySecretsOnce();
  const persisted = await readPersisted();
  const omniRouteApiKey =
    (await SecureStore.getItemAsync(OMNIROUTE_API_KEY)) ?? "";
  const karakeepApiKey =
    (await SecureStore.getItemAsync(KARAKEEP_API_KEY)) ?? "";
  const whisperApiKey = (await SecureStore.getItemAsync(WHISPER_API_KEY)) ?? "";

  return {
    omniRouteUrl: persisted.omniRouteUrl,
    omniRouteApiKey,
    omniRouteModel: persisted.omniRouteModel,
    omniRouteVisionModel: persisted.omniRouteVisionModel,
    llmBackend: persisted.llmBackend,
    persistentNotificationEnabled: persisted.persistentNotificationEnabled,
    autoTranscribeOnSave: persisted.autoTranscribeOnSave,
    richEditorEnabled: persisted.richEditorEnabled,
    previewBeforeSave: persisted.previewBeforeSave,
    captureFolderPath: persisted.captureFolderPath,
    promptOverrides: persisted.promptOverrides,
    karakeepUrl: persisted.karakeepUrl,
    karakeepApiKey,
    whisperEndpoint: persisted.whisperEndpoint,
    whisperApiKey,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    omniRouteUrl: settings.omniRouteUrl,
    omniRouteModel: settings.omniRouteModel,
    omniRouteVisionModel: settings.omniRouteVisionModel,
    llmBackend: settings.llmBackend,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: settings.promptOverrides,
    karakeepUrl: settings.karakeepUrl,
    whisperEndpoint: settings.whisperEndpoint,
  });
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
  }
  if (settings.karakeepApiKey) {
    await SecureStore.setItemAsync(KARAKEEP_API_KEY, settings.karakeepApiKey);
  } else {
    await SecureStore.deleteItemAsync(KARAKEEP_API_KEY);
  }
  if (settings.whisperApiKey) {
    await SecureStore.setItemAsync(WHISPER_API_KEY, settings.whisperApiKey);
  } else {
    await SecureStore.deleteItemAsync(WHISPER_API_KEY);
  }
}

/** Convenience read for the enrich entry points — skips SecureStore so an
 * enrich call doesn't pay the keychain cost just to read the prompt
 * overrides (the API key lives elsewhere in this module). */
export async function getPromptOverrides(): Promise<PromptOverrides> {
  const persisted = await readPersisted();
  return persisted.promptOverrides;
}

/**
 * True if there is an API key stored in SecureStore. Used by the settings
 * UI to render a "•••• configured" placeholder rather than reading the key
 * into React state for display.
 */
export async function hasOmniRouteApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(OMNIROUTE_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the API key. Used by the settings UI. */
export async function setOmniRouteApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
  }
}

/**
 * True if there is a Karakeep API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasKarakeepApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(KARAKEEP_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the Karakeep API key. Used by the settings UI. */
export async function setKarakeepApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(KARAKEEP_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(KARAKEEP_API_KEY);
  }
}

/**
 * True if there is a Whisper API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasWhisperApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(WHISPER_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the Whisper API key. Used by the settings UI. */
export async function setWhisperApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(WHISPER_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(WHISPER_API_KEY);
  }
}

/**
 * Returns true if the user should see the navetted→OmniRoute migration banner.
 * Triggers when: v1 settings blob exists (user was on v0.1) AND banner not yet dismissed.
 */
export async function shouldShowMigrationBanner(): Promise<boolean> {
  const dismissed = await AsyncStorage.getItem(MIGRATION_BANNER_KEY);
  if (dismissed) return false;
  const rawV1 = await AsyncStorage.getItem(SETTINGS_KEY_V1);
  return rawV1 !== null;
}

/**
 * Dismiss the migration banner. Clears the v1 settings blob and the legacy
 * navetted token from SecureStore.
 */
export async function dismissMigrationBanner(): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(MIGRATION_BANNER_KEY, "1"),
    AsyncStorage.removeItem(SETTINGS_KEY_V1),
    SecureStore.deleteItemAsync(LEGACY_NAVETTED_TOKEN_KEY),
  ]);
}
