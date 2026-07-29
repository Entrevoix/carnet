import AsyncStorage from "@react-native-async-storage/async-storage";

const CRASH_LOG_KEY = "carnet:crashlog:v1";

// Small — this is a "what happened when the app died" trail for a
// single-developer dogfooding phase, not an analytics store. See
// .claude/PRPs/plans/completed/self-hosted-sentry.plan.md for why a local
// ring buffer was chosen over a hosted crash-reporting service.
export const CRASH_LOG_LIMIT = 20;

// A thrown value is arbitrary — `String(error)` on a rejected response body or
// a large object can run to megabytes, and AsyncStorage on Android is
// SQLite-backed with a default ~6MB ceiling. One oversized record would fail
// its own write and then re-fail on every subsequent append (it stays in the
// buffer and gets re-serialized), silently killing the log. Clamping at
// construction bounds the whole store to roughly 180KB.
export const MAX_MESSAGE_CHARS = 1_000;
export const MAX_STACK_CHARS = 8_000;

export interface CrashRecord {
  id: string;
  timestamp: number;
  message: string;
  stack?: string;
  isFatal: boolean;
  /**
   * How many times this identical crash fired consecutively. Absent on records
   * written before this field existed — read it as `count ?? 1`.
   */
  count?: number;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
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
  try {
    // error.toString()/message can throw (a hostile or malformed thrown
    // value) — this outer try covers record construction. The inner try
    // below covers the queued write separately, so one bad write can't
    // permanently poison writeQueue for every crash recorded afterward.
    const rawStack = error instanceof Error ? error.stack : undefined;
    const record: CrashRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      message: clamp(
        error instanceof Error ? error.message : String(error),
        MAX_MESSAGE_CHARS,
      ),
      stack: rawStack === undefined ? undefined : clamp(rawStack, MAX_STACK_CHARS),
      isFatal: opts.isFatal ?? false,
    };
    writeQueue = writeQueue.then(async () => {
      try {
        const existing = await readLog();
        // Collapse a consecutive repeat of the same crash into a counter
        // instead of prepending. A deterministic render error the user retries
        // (CrashBoundary's "Try again") or a handler that re-fires would
        // otherwise evict every distinct earlier crash from a 20-slot buffer.
        const newest = existing[0];
        const isRepeat =
          newest !== undefined &&
          newest.message === record.message &&
          newest.stack === record.stack &&
          newest.isFatal === record.isFatal;
        const next = isRepeat
          ? [
              {
                ...newest,
                timestamp: record.timestamp,
                count: (newest.count ?? 1) + 1,
              },
              ...existing.slice(1),
            ]
          : [record, ...existing].slice(0, CRASH_LOG_LIMIT);
        await AsyncStorage.setItem(CRASH_LOG_KEY, JSON.stringify(next));
      } catch {
        // Best-effort — see doc comment above.
      }
    });
    await writeQueue;
  } catch {
    // Best-effort — see doc comment above.
  }
}

export async function getCrashLog(): Promise<CrashRecord[]> {
  return readLog();
}

export async function clearCrashLog(): Promise<void> {
  await AsyncStorage.removeItem(CRASH_LOG_KEY);
}
