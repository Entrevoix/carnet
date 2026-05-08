import AsyncStorage from "@react-native-async-storage/async-storage";
import { v4 as uuidv4 } from "uuid";

const SETTINGS_KEY = "carnet:settings:v1";
const CLIENT_ID_KEY = "carnet:client_id:v1";

export interface Settings {
  navettedUrl: string;
  navettedToken: string;
  omniRouteUrl: string;
}

const DEFAULT_SETTINGS: Settings = {
  navettedUrl: "ws://100.0.0.1:7878",
  navettedToken: "",
  omniRouteUrl: "http://192.168.1.20:20128",
};

export async function getSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Stable per-install client ID, generated on first call and persisted. Used
 * as the `client_id` in the navetted hello v2 handshake.
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
