import { recordCrash } from "./crashLog";

type ErrorUtilsHandler = (error: unknown, isFatal: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler?: () => ErrorUtilsHandler | undefined;
  setGlobalHandler?: (handler: ErrorUtilsHandler) => void;
}

let installed = false;

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
    recordCrash(error, { isFatal }).catch(() => undefined);
    previousHandler?.(error, isFatal);
  });
  installed = true;
}
