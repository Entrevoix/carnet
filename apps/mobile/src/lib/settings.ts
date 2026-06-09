import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const SETTINGS_KEY = "carnet:settings:v2";
/** Legacy key — read once for migration, then ignored. */
const SETTINGS_KEY_V1 = "carnet:settings:v1";
/** Legacy SecureStore key from v0.1's navetted HMAC token. Purged on first
 * v0.2 settings load — see purgeLegacySecretsOnce(). */
const LEGACY_NAVETTED_TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
/** Flag: user dismissed the navetted→OmniRoute migration banner. */
const MIGRATION_BANNER_KEY = "carnet:migration_banner_dismissed:v1";
/** Flag: legacy SecureStore secrets purged. Set to "1" after the one-time
 * unconditional sweep so we don't hit SecureStore on every getSettings(). */
const LEGACY_PURGE_KEY = "carnet:legacy_purge:v1";

export const DEFAULT_OMNIROUTE_MODEL = "openrouter/openai/gpt-4o-mini";
/** Default transcription model. Uses Gemini's audio modality via the
 * /v1/chat/completions endpoint (LiteLLM bridges OpenAI's `input_audio`
 * content type to Gemini natively). Cheaper and faster than Whisper on
 * most proxies, no separate /v1/audio/transcriptions route required. */
export const DEFAULT_TRANSCRIPTION_MODEL = "gemini/gemini-2.5-flash-lite";

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
  /** Whisper-compatible model for /v1/audio/transcriptions. Defaults to
   * whisper-1. Held separately from omniRouteModel so swapping the chat
   * model doesn't break transcription (and vice versa). */
  omniRouteTranscriptionModel: string;
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
   * Root folder for captured notes. Defaults to the app sandbox carnet/ dir.
   * Set to a Syncthing-watched folder for automatic sync to workstation.
   */
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
}

interface PersistedSettings {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteTranscriptionModel: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  richEditorEnabled: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
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
  omniRouteTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  persistentNotificationEnabled: false,
  autoTranscribeOnSave: false,
  richEditorEnabled: false,
  captureFolderPath: "",
  promptOverrides: {},
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
        omniRouteTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: false,
        captureFolderPath: legacy.captureFolderPath ?? "",
        promptOverrides: {},
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
    omniRouteTranscriptionModel: settings.omniRouteTranscriptionModel,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: sanitisePromptOverrides(settings.promptOverrides),
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

  return {
    omniRouteUrl: persisted.omniRouteUrl,
    omniRouteApiKey,
    omniRouteModel: persisted.omniRouteModel,
    omniRouteTranscriptionModel: persisted.omniRouteTranscriptionModel,
    persistentNotificationEnabled: persisted.persistentNotificationEnabled,
    autoTranscribeOnSave: persisted.autoTranscribeOnSave,
    richEditorEnabled: persisted.richEditorEnabled,
    captureFolderPath: persisted.captureFolderPath,
    promptOverrides: persisted.promptOverrides,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    omniRouteUrl: settings.omniRouteUrl,
    omniRouteModel: settings.omniRouteModel,
    omniRouteTranscriptionModel: settings.omniRouteTranscriptionModel,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: settings.promptOverrides,
  });
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
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
