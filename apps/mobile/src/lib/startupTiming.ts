/**
 * Cold-start budget tracking (2026-07-17 market research rec #4).
 *
 * Capture LAUNCH SPEED is carnet's competitive moat — the #1 validated
 * Obsidian-mobile complaint is 5-15s to jot an idea — and nothing guarded it:
 * a dependency bump that doubles cold start would ship silently. This module
 * is the guard's measuring half: App.tsx stamps module-evaluation time, the
 * Home screen reports first interactive paint, and a breach logs loudly
 * enough to show up in logcat during the release smoke test
 * (docs/smoke-test.md). No analytics, nothing persisted off-device.
 */

/** Budget for JS-bundle evaluation start → Home interactive. A CONSERVATIVE
 * ceiling pending a measured baseline (read the dev-build `[startup]` metric
 * line to calibrate, then tighten): the point is a regression tripwire that
 * fires on a real JS-side doubling, not on a slow launch day. Competitors'
 * complained-about cold starts are 5-15s; anything past 3s erodes the moat. */
export const COLD_START_BUDGET_MS = 3_000;

/** Stamped when this module first evaluates. App.tsx imports this module
 * FIRST among app code, so this approximates JS-bundle evaluation start —
 * the earliest instant app code can observe. (Kept here, not in App.tsx: a
 * value export from App would create a runtime App ⇄ HomeScreen import
 * cycle; both sides importing this leaf module instead is cycle-free.) */
export const BOOT_TIMESTAMP_MS = Date.now();

let reported = false;

/** Pure classifier — exported for tests. */
export function isColdStartBreach(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs > budgetMs;
}

/**
 * Report cold-start completion once per process. Called from the Home
 * screen's first mount with App.tsx's module-evaluation timestamp; later
 * calls (re-mounts, navigation back to Home) are no-ops so the metric always
 * means "cold start", never "screen revisit".
 *
 * Within budget → a dev-build-only metric line (release builds strip
 * console.log, so an always-on line would be dead weight there anyway).
 * Over budget → console.warn — warns SURVIVE release stripping, so the
 * smoke-test check is simply "no [startup] breach warn in logcat".
 */
export function reportColdStart(
  bootTimestampMs: number = BOOT_TIMESTAMP_MS,
  nowMs: number = Date.now(),
  budgetMs: number = COLD_START_BUDGET_MS,
): number | null {
  if (reported) return null;
  reported = true;
  const elapsed = nowMs - bootTimestampMs;
  if (isColdStartBreach(elapsed, budgetMs)) {
    console.warn(
      `[startup] cold start ${elapsed}ms EXCEEDS the ${budgetMs}ms budget — a recent change likely regressed launch speed (capture latency is the product's moat; see lib/startupTiming.ts)`,
    );
  } else if (typeof __DEV__ !== "undefined" && __DEV__) {
    // Metric, not a problem — dev builds only (release strips console.log).
    console.log(`[startup] cold start ${elapsed}ms (budget ${budgetMs}ms)`);
  }
  return elapsed;
}

/** Test seam — resets the once-per-process latch. */
export function _resetColdStartForTests(): void {
  reported = false;
}
