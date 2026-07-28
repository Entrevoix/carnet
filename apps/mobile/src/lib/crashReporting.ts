import { recordCrash } from "./crashLog";

type ErrorUtilsHandler = (error: unknown, isFatal: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler?: () => ErrorUtilsHandler | undefined;
  setGlobalHandler?: (handler: ErrorUtilsHandler) => void;
}

let installed = false;

/**
 * How long a fatal crash's log write may delay RN's default handling. Fatal
 * errors tear the app down as soon as the default handler runs, so an
 * unawaited AsyncStorage write races the teardown — and those are exactly the
 * crashes the log exists to preserve. Bounded so a hung write can't suppress
 * redbox/restart entirely.
 */
export const FATAL_FLUSH_TIMEOUT_MS = 250;

/**
 * Chains onto React Native's global JS-exception handler so every uncaught
 * error (not just ones a component's error boundary happens to catch) gets
 * appended to the local crash log before RN's default handling (redbox in
 * dev, app-restart in release) runs. Idempotent — safe to call more than
 * once (e.g. Fast Refresh) without stacking duplicate handlers.
 */
export function installGlobalCrashHandler(): void {
  if (installed) return;
  const errorUtils = (global as unknown as { ErrorUtils?: ErrorUtilsLike })
    .ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;

  const previousHandler = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    const written = recordCrash(error, { isFatal }).catch(() => undefined);
    if (!isFatal) {
      // Non-fatal: the app keeps running, so the write will land on its own.
      previousHandler?.(error, isFatal);
      return;
    }
    void Promise.race([
      written,
      new Promise((resolve) => setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS)),
    ]).then(() => previousHandler?.(error, isFatal));
  });
  installed = true;
}
