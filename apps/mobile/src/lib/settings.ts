import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { buildDefaultProviders, type LlmProvider } from "./llmProviders";

const SETTINGS_KEY = "carnet:settings:v2";
/** Legacy key — read once for migration, then ignored. */
const SETTINGS_KEY_V1 = "carnet:settings:v1";
/** Legacy SecureStore key from v0.1's navetted HMAC token. Purged on first
 * v0.2 settings load — see purgeLegacySecretsOnce(). */
const LEGACY_NAVETTED_TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
const KARAKEEP_API_KEY = "carnet_karakeep_api_key";
const LOCAL_LLM_API_KEY = "carnet_local_llm_api_key";
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

/**
 * Legacy enrichment-backend selector — REMOVED from {@link Settings} as of
 * the LLM provider list (Phase 2, see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md). Kept here,
 * type-only, purely to give the one-time migration in this file a name for
 * the shape it reads off an old persisted blob. Do not use for anything new
 * — `Settings.activeProviderId` replaces it.
 */
type LegacyLlmBackend = "omniroute" | "on-device" | "local";

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
  /** Every configured LLM endpoint — shipped presets (possibly edited) plus
   * any user-created custom entries. Never empty: migration and
   * DEFAULT_PERSISTED both seed it with {@link buildDefaultProviders}. */
  llmProviders: LlmProvider[];
  /** Which entry in {@link llmProviders} serves captures. Read fresh on
   * every dispatcher call (not cached), so switching providers mid-session
   * takes effect on the very next capture. */
  activeProviderId: string;
  /** OmniRoute API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob. Kept as a dedicated field (rather than
   * folded into a generic per-provider key lookup here) because it predates
   * the provider list and existing UI code reads it directly; new provider
   * ids fetch their key via providerKeys.ts instead. */
  omniRouteApiKey: string;
  /** Local-LLM (Relais) API key (Bearer). Held in SecureStore, never
   * persisted to the AsyncStorage settings blob — mirrors omniRouteApiKey.
   * Optional in practice: Relais's loopback port is unauthenticated, but the
   * field stays available for a LAN-facing/authenticated deployment. */
  localLlmApiKey: string;
  /** JS-side hint for the Settings UI's initial render — avoids a Switch
   * flicker before the async native read resolves. Source of truth lives
   * in native SharedPreferences (BootReceiver reads it directly). Whenever
   * these two diverge, native wins; SettingsScreen reconciles on mount. */
  persistentNotificationEnabled: boolean;
  /** When true, audio captures auto-run on-device transcription after save.
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
}

interface PersistedSettings {
  llmProviders: LlmProvider[];
  activeProviderId: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
}

/** Shape of a v1 settings blob — used for one-time migration read. */
interface LegacyPersistedSettings {
  navettedUrl?: string;
  omniRouteUrl?: string;
  captureFolderPath?: string;
}

/** Shape of a pre-provider-list (Phase 1 and earlier) v2 settings blob —
 * used for the one-time llmProviders migration in readPersisted(). */
interface LegacyLlmPersistedSettings {
  omniRouteUrl?: string;
  omniRouteModel?: string;
  omniRouteVisionModel?: string;
  localLlmUrl?: string;
  localLlmModel?: string;
  llmBackend?: LegacyLlmBackend;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  llmProviders: buildDefaultProviders(),
  activeProviderId: "omniroute",
  persistentNotificationEnabled: false,
  autoTranscribeOnSave: false,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "",
  promptOverrides: {},
  karakeepUrl: "",
};

/**
 * One-time migration from the pre-provider-list settings shape (a
 * `llmBackend` field, `omniRoute*`/`localLlm*` flat fields, no
 * `llmProviders`) to the provider list. Pure function of the parsed blob —
 * calling it twice on the same input yields structurally identical output,
 * which is what makes it safe to run on every read of an unmigrated blob
 * (this module never writes the migrated shape back to AsyncStorage itself;
 * the next explicit saveSettings() call persists it).
 *
 * Deliberately does NOT touch SecureStore — the design spec's proposed step
 * of re-filing API keys under new aliases is overridden; see providerKeys.ts
 * for why (a key that never moves cannot be lost).
 */
function migrateLegacyLlmSettings(
  legacy: LegacyLlmPersistedSettings,
): Pick<PersistedSettings, "llmProviders" | "activeProviderId"> {
  const providers = buildDefaultProviders();
  const omniroute = providers.find((p) => p.id === "omniroute");
  if (omniroute) {
    omniroute.baseUrl = legacy.omniRouteUrl ?? "";
    omniroute.model = legacy.omniRouteModel ?? "";
    omniroute.visionModel = legacy.omniRouteVisionModel ?? "";
  }
  const relais = providers.find((p) => p.id === "relais");
  if (relais) {
    // Blank local URL keeps the loopback default (matches today's
    // behavior — localLlm.ts always fell back to 127.0.0.1:8080 rather
    // than treating a blank URL as not-configured).
    const trimmedLocalUrl = (legacy.localLlmUrl ?? "").trim();
    if (trimmedLocalUrl) relais.baseUrl = trimmedLocalUrl;
    relais.model = legacy.localLlmModel ?? "";
  }
  // "on-device" never had an implementation, so anyone holding that value
  // was already falling through — it maps to relais, same as "local". A
  // MISSING llmBackend (a blob older than the field itself) defaults to
  // "omniroute", matching the old `{...DEFAULT_PERSISTED, ...parsed}`
  // merge's behavior (DEFAULT_LLM_BACKEND was "omniroute").
  const activeProviderId =
    legacy.llmBackend === "local" || legacy.llmBackend === "on-device"
      ? "relais"
      : "omniroute";
  return { llmProviders: providers, activeProviderId };
}

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
      const parsed = JSON.parse(raw) as Partial<PersistedSettings> &
        LegacyLlmPersistedSettings;
      // Migration trigger: a blob carrying ANY pre-provider-list LLM field
      // (llmBackend, or one of the flat omniRoute*/localLlm* fields — an
      // even older blob predating llmBackend itself can still have these
      // without it) and no `llmProviders` yet is pre-provider-list.
      // Idempotent — once a migrated (or fresh) blob is saved, it carries
      // `llmProviders` and this branch is never taken again for it.
      const hasLegacyLlmFields =
        parsed.llmBackend !== undefined ||
        parsed.omniRouteUrl !== undefined ||
        parsed.omniRouteModel !== undefined ||
        parsed.omniRouteVisionModel !== undefined ||
        parsed.localLlmUrl !== undefined ||
        parsed.localLlmModel !== undefined;
      const llmFields =
        !parsed.llmProviders && hasLegacyLlmFields
          ? migrateLegacyLlmSettings(parsed)
          : {
              llmProviders: parsed.llmProviders ?? buildDefaultProviders(),
              activeProviderId: parsed.activeProviderId ?? DEFAULT_PERSISTED.activeProviderId,
            };
      return {
        ...DEFAULT_PERSISTED,
        ...parsed,
        ...llmFields,
        promptOverrides: sanitisePromptOverrides(parsed.promptOverrides),
      };
    } catch {
      return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
    }
  }

  // Try migrating from v1 blob
  const rawV1 = await AsyncStorage.getItem(SETTINGS_KEY_V1);
  if (rawV1) {
    try {
      const legacy = JSON.parse(rawV1) as LegacyPersistedSettings;
      return {
        llmProviders: buildDefaultProviders(),
        activeProviderId: DEFAULT_PERSISTED.activeProviderId,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: legacy.captureFolderPath ?? "",
        promptOverrides: {},
        karakeepUrl: "",
      };
    } catch {
      return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
    }
  }

  return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
}

async function writePersisted(settings: PersistedSettings): Promise<void> {
  const sanitised: PersistedSettings = {
    llmProviders: settings.llmProviders,
    activeProviderId: settings.activeProviderId,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: sanitisePromptOverrides(settings.promptOverrides),
    karakeepUrl: settings.karakeepUrl,
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
  const localLlmApiKey =
    (await SecureStore.getItemAsync(LOCAL_LLM_API_KEY)) ?? "";

  return {
    llmProviders: persisted.llmProviders,
    activeProviderId: persisted.activeProviderId,
    omniRouteApiKey,
    localLlmApiKey,
    persistentNotificationEnabled: persisted.persistentNotificationEnabled,
    autoTranscribeOnSave: persisted.autoTranscribeOnSave,
    richEditorEnabled: persisted.richEditorEnabled,
    previewBeforeSave: persisted.previewBeforeSave,
    captureFolderPath: persisted.captureFolderPath,
    promptOverrides: persisted.promptOverrides,
    karakeepUrl: persisted.karakeepUrl,
    karakeepApiKey,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    llmProviders: settings.llmProviders,
    activeProviderId: settings.activeProviderId,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: settings.promptOverrides,
    karakeepUrl: settings.karakeepUrl,
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
  if (settings.localLlmApiKey) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, settings.localLlmApiKey);
  } else {
    await SecureStore.deleteItemAsync(LOCAL_LLM_API_KEY);
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
 * True if there is a local-LLM API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasLocalLlmApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(LOCAL_LLM_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the local-LLM API key. Used by the settings UI. */
export async function setLocalLlmApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(LOCAL_LLM_API_KEY);
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
