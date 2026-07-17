/**
 * Shared scaffolding for the two AsyncStorage-backed queues — the offline
 * capture queue (lib/queue.ts) and the pending Karakeep-export queue
 * (lib/pendingSync.ts). The QUEUES stay separate on purpose (different
 * semantics — raw captures awaiting enrichment vs pointers to notes awaiting
 * a reachable host); these three utilities were byte-identical copies and are
 * extracted so they can't drift. `sanitizeError` is the load-bearing one: it
 * is the Bearer-token redactor run before any error string is PERSISTED, and
 * a credential-format fix landing in one copy but not the other would leak a
 * token from whichever queue was missed (2026-07-16 audit finding).
 */

/**
 * Create a promise-chain mutex. Each queue keeps its OWN lock (call this once
 * per module) — the two queues never contend with each other, only with their
 * own concurrent read-modify-writes (enqueue during a drain pass would
 * otherwise lose a row; SQLite gave per-statement atomicity for free,
 * AsyncStorage RMW does not).
 */
export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let lock: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/**
 * Non-crypto, unique-enough row id. uuid needs crypto.getRandomValues, which
 * RN/Hermes lacks without the (uninstalled) react-native-get-random-values
 * polyfill — calling it threw and stranded offline captures on the spinner.
 * A queue-row id only needs local uniqueness.
 */
export function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Strip Bearer tokens from any error string before it's persisted or shown.
 * Thin re-export of the ONE canonical redactor (lib/httpClient.ts) so the
 * queues, OmniRoute, and Karakeep can never drift apart on what counts as a
 * credential. */
export { sanitizeErrorMessage as sanitizeError } from "./httpClient";
