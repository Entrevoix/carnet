/**
 * Web-side persistence: settings + last-N captures via localStorage. The
 * shape mirrors apps/mobile/src/lib/{settings,storage}.ts so screens can be
 * ported almost verbatim.
 *
 * Token handling: `navettedToken` lives in the OS keychain (via the Tauri
 * commands wrapped in `secureStorage.ts`), never localStorage. Settings
 * URL/OmniRoute and recent captures stay in localStorage — non-sensitive.
 */

import {
  deleteNavettedToken,
  getNavettedToken,
  setNavettedToken,
} from "./secureStorage";

const SETTINGS_KEY = "carnet:settings:v1";
const CLIENT_ID_KEY = "carnet:client_id:v1";
const HISTORY_KEY = "carnet:history:v1";
const HISTORY_LIMIT = 5;

export interface Settings {
  navettedUrl: string;
  navettedToken: string;
  omniRouteUrl: string;
}

interface PersistedSettings {
  navettedUrl: string;
  omniRouteUrl: string;
  // Legacy: pre-keychain installs persisted the token here. Migrated to
  // the keychain on first read, then stripped from disk.
  navettedToken?: string;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  navettedUrl: "ws://localhost:7878",
  omniRouteUrl: "",
};

export type CaptureMode = "idea" | "journal" | "person";

export interface CaptureEntry {
  id: string;
  mode: CaptureMode;
  title: string;
  filepath: string;
  createdAt: number;
}

function readPersisted(): PersistedSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_PERSISTED };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return { ...DEFAULT_PERSISTED, ...parsed };
  } catch {
    return { ...DEFAULT_PERSISTED };
  }
}

function writePersisted(settings: PersistedSettings): void {
  // Strip the legacy navettedToken field even if a caller passed it in.
  const sanitised: PersistedSettings = {
    navettedUrl: settings.navettedUrl,
    omniRouteUrl: settings.omniRouteUrl,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitised));
}

/**
 * Public, sync-safe read of the non-sensitive persisted fields. Used by the
 * Settings screen to recover URL/OmniRoute when the keychain read fails — the
 * localStorage data is still readable even when the OS keychain is unreachable.
 */
export function readPersistedSettings(): {
  navettedUrl: string;
  omniRouteUrl: string;
} {
  const p = readPersisted();
  return { navettedUrl: p.navettedUrl, omniRouteUrl: p.omniRouteUrl };
}

export async function getSettings(): Promise<Settings> {
  const persisted = readPersisted();
  const token = (await getNavettedToken()) ?? "";

  if (!token && persisted.navettedToken) {
    // One-time migration: keychain empty, legacy localStorage token present.
    // Move the secret across, then strip the legacy field. Order matters —
    // never strip before the keychain write succeeds, or a Linux box without
    // a keyring daemon would lose the user's pairing.
    const migrated = persisted.navettedToken;
    await setNavettedToken(migrated);
    writePersisted(persisted);
    return {
      navettedUrl: persisted.navettedUrl,
      omniRouteUrl: persisted.omniRouteUrl,
      navettedToken: migrated,
    };
  }

  if (token && persisted.navettedToken !== undefined) {
    // Defense-in-depth: keychain already has a token, but legacy localStorage
    // field is still present. This means a prior migration's keychain write
    // succeeded but the strip step was interrupted (process kill, crash, etc.).
    // Strip it now so the secret stops sitting in plaintext.
    writePersisted(persisted);
  }

  return {
    navettedUrl: persisted.navettedUrl,
    omniRouteUrl: persisted.omniRouteUrl,
    navettedToken: token,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  writePersisted({
    navettedUrl: settings.navettedUrl,
    omniRouteUrl: settings.omniRouteUrl,
  });
  if (settings.navettedToken) {
    await setNavettedToken(settings.navettedToken);
  } else {
    await deleteNavettedToken();
  }
}

export function getClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = `desktop-${Math.random().toString(36).slice(2, 12)}`;
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function getRecentCaptures(): CaptureEntry[] {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CaptureEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordCapture(entry: CaptureEntry): void {
  const existing = getRecentCaptures();
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
