/**
 * Two small, unrelated-but-trivial value generators CaptureScreen needed at
 * several call sites (recents-history entries, journal filenames): a local
 * id and today's local-calendar date. Split out of CaptureScreen.tsx as a
 * move-only extraction — neither depends on component state, so both are
 * plain functions rather than hooks.
 */

/**
 * Non-crypto local ID — only used as a key for the recents history list, not
 * for anything security-sensitive. uuid v11 requires crypto.getRandomValues,
 * which RN doesn't provide without the react-native-get-random-values
 * polyfill (which would require a native rebuild). This avoids that whole
 * detour.
 */
export const localId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Local-date YYYY-MM-DD (NOT UTC). Late-evening captures in UTC- timezones
 * must land in today's journal, not tomorrow's.
 */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
