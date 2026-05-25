import AsyncStorage from "@react-native-async-storage/async-storage";

const HISTORY_KEY = "carnet:history:v1";
const HISTORY_LIMIT = 20;

export type CaptureMode = "idea" | "journal" | "person" | "photo" | "audio";

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

/**
 * Remove many entries by id in a single write. Used by Home's multi-select
 * bulk delete so cleaning up N rows is one AsyncStorage round-trip instead
 * of N. Unknown ids are silently ignored. Skips the write when no entries
 * actually match — avoids touching storage on empty input or all-unknown
 * inputs.
 */
export async function removeManyFromHistory(
  ids: ReadonlyArray<string>,
): Promise<void> {
  if (ids.length === 0) return;
  const toRemove = new Set(ids);
  const existing = await getRecentCaptures();
  const next = existing.filter((e) => !toRemove.has(e.id));
  if (next.length === existing.length) return;
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

/**
 * Update the title of a single capture entry in place. Used when the user
 * edits the H1 of a note from inside carnet — keeps the recents list in
 * sync with the file content. Unknown ids are silently ignored. Skips the
 * write when the existing title already matches to avoid an empty
 * round-trip (common case: user edited the body but not the H1).
 */
export async function updateCaptureTitle(
  id: string,
  title: string,
): Promise<void> {
  const existing = await getRecentCaptures();
  const idx = existing.findIndex((e) => e.id === id);
  if (idx === -1) return;
  if (existing[idx].title === title) return;
  const next = [...existing];
  next[idx] = { ...next[idx], title };
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
