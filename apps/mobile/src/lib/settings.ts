import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { v4 as uuidv4 } from "uuid";

const SETTINGS_KEY = "carnet:settings:v1";
const CLIENT_ID_KEY = "carnet:client_id:v1";
const TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";

export interface Settings {
  navettedUrl: string;
  navettedToken: string;
  omniRouteUrl: string;
  omniRouteApiKey: string;
}

interface PersistedSettings {
  navettedUrl: string;
  omniRouteUrl: string;
  // navettedToken intentionally absent — lives in SecureStore.
  navettedToken?: string; // legacy, migrated on first read
}

const DEFAULT_PERSISTED: PersistedSettings = {
  navettedUrl: "ws://100.0.0.1:7878",
  omniRouteUrl: "http://192.168.1.20:20128",
};

async function readPersisted(): Promise<PersistedSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return { ...DEFAULT_PERSISTED };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return { ...DEFAULT_PERSISTED, ...parsed };
  } catch {
    return { ...DEFAULT_PERSISTED };
  }
}

async function writePersisted(settings: PersistedSettings): Promise<void> {
  const sanitised: PersistedSettings = {
    navettedUrl: settings.navettedUrl,
    omniRouteUrl: settings.omniRouteUrl,
  };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitised));
}

export async function getSettings(): Promise<Settings> {
  const persisted = await readPersisted();
  let token = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? "";
  const omniRouteApiKey = (await SecureStore.getItemAsync(OMNIROUTE_API_KEY)) ?? "";

  // One-time migration: if the AsyncStorage blob still has a token (from
  // a pre-secure-store install), move it to SecureStore and strip from
  // the on-disk JSON.
  if (!token && persisted.navettedToken) {
    token = persisted.navettedToken;
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    await writePersisted(persisted); // strips the legacy field
  }

  return {
    navettedUrl: persisted.navettedUrl,
    omniRouteUrl: persisted.omniRouteUrl,
    navettedToken: token,
    omniRouteApiKey,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    navettedUrl: settings.navettedUrl,
    omniRouteUrl: settings.omniRouteUrl,
  });
  if (settings.navettedToken) {
    await SecureStore.setItemAsync(TOKEN_KEY, settings.navettedToken);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
  }
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
