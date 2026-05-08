/**
 * Web-side persistence: settings + last-N captures via localStorage. The
 * shape mirrors apps/mobile/src/lib/{settings,storage}.ts so screens can be
 * ported almost verbatim.
 */

const SETTINGS_KEY = "carnet:settings:v1";
const CLIENT_ID_KEY = "carnet:client_id:v1";
const HISTORY_KEY = "carnet:history:v1";
const HISTORY_LIMIT = 5;

export interface Settings {
  navettedUrl: string;
  navettedToken: string;
  omniRouteUrl: string;
}

const DEFAULT_SETTINGS: Settings = {
  navettedUrl: "ws://localhost:7878",
  navettedToken: "",
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

export function getSettings(): Settings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
