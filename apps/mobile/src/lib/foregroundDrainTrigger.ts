/**
 * Throttled "drain on foreground" trigger.
 *
 * App.tsx fires a drain at cold start and on every AppState 'active'
 * transition (mirroring the existing Karakeep pending-sync trigger it already
 * had). The throttle/single-kick decision is extracted here, pure and
 * React-free, so it's unit-testable without mounting the full app tree —
 * App.tsx just wires `kick` to its two triggers (mount + AppState listener).
 *
 * The wrapped `drain` is never allowed to reject past this trigger: a
 * fire-and-forget AppState callback with an unhandled rejection would be a
 * silent crash-adjacent bug, so failures are caught and logged instead.
 */

export interface ForegroundDrainTrigger {
  /** Call at mount and on every AppState 'active' transition. No-ops (and
   * does not invoke `drain`) if the last kick landed within `throttleMs`. */
  kick: () => void;
}

/**
 * @param drain the drain to run — expected to be single-flight and a cheap
 *   no-op on an empty queue (as lib/queue.ts's drainQueue and
 *   lib/pendingSyncRunner.ts's drainPendingKarakeepExports both are), since
 *   this trigger only decides WHEN, not whether a pass is safe to overlap.
 * @param throttleMs minimum time between kicks that actually run `drain`.
 * @param label used in the warning log if `drain` rejects.
 * @param now injectable clock for tests.
 */
export function createForegroundDrainTrigger(
  drain: () => Promise<void> | void,
  throttleMs: number,
  label: string,
  now: () => number = Date.now,
): ForegroundDrainTrigger {
  // -Infinity (not 0) so the very first kick always fires, even against an
  // injected clock that itself starts at 0 in tests.
  let lastDrainAt = -Infinity;
  return {
    kick: () => {
      const at = now();
      if (at - lastDrainAt < throttleMs) return;
      lastDrainAt = at;
      Promise.resolve()
        .then(drain)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[${label}] drain failed:`, msg);
        });
    },
  };
}
