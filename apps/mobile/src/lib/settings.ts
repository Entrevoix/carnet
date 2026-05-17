import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { v4 as uuidv4 } from "uuid";

const SETTINGS_KEY = "carnet:settings:v2";
/** Legacy key — read once for migration, then ignored. */
const SETTINGS_KEY_V1 = "carnet:settings:v1";
const CLIENT_ID_KEY = "carnet:client_id:v1";
const TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
/** Flag: user dismissed the navetted→OmniRoute migration banner. */
const MIGRATION_BANNER_KEY = "carnet:migration_banner_dismissed:v1";

export interface Settings {
  omniRouteUrl: string;
  omniRouteApiKey: string;
  /**
   * Root folder for captured notes. Defaults to the app sandbox carnet/ dir.
   * Set to a Syncthing-watched folder for automatic sync to workstation.
   */
  captureFolderPath: string;
}

interface PersistedSettings {
  omniRouteUrl: string;
  captureFolderPath: string;
}

/** Shape of a v1 settings blob — used for one-time migration read. */
interface LegacyPersistedSettings {
  navettedUrl?: string;
  omniRouteUrl?: string;
  captureFolderPath?: string;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  omniRouteUrl: "",
  captureFolderPath: "",
};

async function readPersisted(): Promise<PersistedSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      return { ...DEFAULT_PERSISTED, ...parsed };
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
        captureFolderPath: legacy.captureFolderPath ?? "",
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
    captureFolderPath: settings.captureFolderPath,
  };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitised));
}

export async function getSettings(): Promise<Settings> {
  const persisted = await readPersisted();
  const omniRouteApiKey = (await SecureStore.getItemAsync(OMNIROUTE_API_KEY)) ?? "";

  return {
    omniRouteUrl: persisted.omniRouteUrl,
    omniRouteApiKey,
    captureFolderPath: persisted.captureFolderPath,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    omniRouteUrl: settings.omniRouteUrl,
    captureFolderPath: settings.captureFolderPath,
  });
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
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
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
}

/**
 * Stable per-install client ID, generated on first call and persisted. Used
 * as the `client_id` in the navetted hello v2 handshake. Not sensitive —
 * stays in AsyncStorage.
 */
export async function getClientId(): Promise<string> {
  const existing = await AsyncStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = uuidv4();
  await AsyncStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}
