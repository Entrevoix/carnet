import AsyncStorage from "@react-native-async-storage/async-storage";

const CRASH_LOG_KEY = "carnet:crashlog:v1";

// Small — this is a "what happened when the app died" trail for a
// single-developer dogfooding phase, not an analytics store. See
// .claude/PRPs/plans/completed/self-hosted-sentry.plan.md for why a local
// ring buffer was chosen over a hosted crash-reporting service.
export const CRASH_LOG_LIMIT = 20;

export interface CrashRecord {
  id: string;
  timestamp: number;
  message: string;
  stack?: string;
  isFatal: boolean;
}

async function readLog(): Promise<CrashRecord[]> {
  const raw = await AsyncStorage.getItem(CRASH_LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CrashRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Serializes recordCrash's read-modify-write so two crashes firing close
// together (a common shape — one error triggering a follow-on error) can't
// both read the same `existing` array and have the second setItem clobber
// the first. Chained onto this promise rather than a lock/mutex library —
// AsyncStorage calls are already async, so this just orders them.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Appends a crash record (newest-first, capped at CRASH_LOG_LIMIT). Must
 * never throw — this is called from the global JS-error handler, where a
 * throw would either be swallowed by the runtime or recurse back into
 * itself, and either way the original crash is more important than logging
 * it.
 */
export async function recordCrash(
  error: unknown,
  opts: { isFatal?: boolean } = {},
): Promise<void> {
  const record: CrashRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    isFatal: opts.isFatal ?? false,
  };
  writeQueue = writeQueue.then(async () => {
    try {
      const existing = await readLog();
      const next = [record, ...existing].slice(0, CRASH_LOG_LIMIT);
      await AsyncStorage.setItem(CRASH_LOG_KEY, JSON.stringify(next));
    } catch {
      // Best-effort — see doc comment above.
    }
  });
  await writeQueue;
}

export async function getCrashLog(): Promise<CrashRecord[]> {
  return readLog();
}

export async function clearCrashLog(): Promise<void> {
  await AsyncStorage.removeItem(CRASH_LOG_KEY);
}
