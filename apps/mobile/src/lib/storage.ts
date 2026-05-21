import AsyncStorage from "@react-native-async-storage/async-storage";

const HISTORY_KEY = "carnet:history:v1";
const HISTORY_LIMIT = 20;

export type CaptureMode = "idea" | "journal" | "person" | "photo";

export interface CaptureEntry {
  id: string;
  mode: CaptureMode;
  title: string;
  filepath: string;
  createdAt: number;
}

export async function getRecentCaptures(): Promise<CaptureEntry[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as CaptureEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordCapture(entry: CaptureEntry): Promise<void> {
  const existing = await getRecentCaptures();
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

export async function removeFromHistory(id: string): Promise<void> {
  const existing = await getRecentCaptures();
  const next = existing.filter((e) => e.id !== id);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
