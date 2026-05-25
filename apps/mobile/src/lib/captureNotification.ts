/**
 * JS-side facade for the persistent capture notification.
 *
 * Wraps the native CaptureNotification bridge module so callers don't have
 * to know about NativeModules quirks (missing under Expo Go, undefined
 * when the package wasn't autolinked, etc.) and the API is typed.
 *
 * Permission flow: Android 13+ gates POST_NOTIFICATIONS at runtime via a
 * manifest perm declared by the config plugin. `requestPermission()`
 * surfaces the OS dialog via the built-in PermissionsAndroid API — no new
 * dependency. Callers should request before calling `start()`; without
 * the grant the service runs but the notification is silently suppressed.
 */

import { NativeModules, PermissionsAndroid, Platform } from "react-native";

interface CaptureNotificationNative {
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  isEnabled: () => Promise<boolean>;
}

function getNative(): CaptureNotificationNative | null {
  // Module is Android-only; iOS will never have it registered.
  if (Platform.OS !== "android") return null;
  const mod = (NativeModules as Record<string, unknown>).CaptureNotification;
  if (!mod) return null;
  return mod as CaptureNotificationNative;
}

export function isAvailable(): boolean {
  return getNative() !== null;
}

/**
 * Trigger the OS POST_NOTIFICATIONS prompt (Android 13+). Returns true if
 * the user granted (or if the prompt isn't needed on older Android). The
 * caller should NOT start the service if this returns false — the
 * notification would be invisible.
 *
 * Uses PermissionsAndroid (built-in) rather than expo-notifications so we
 * don't pull in a new dependency for a one-shot prompt.
 */
export async function requestPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  // POST_NOTIFICATIONS landed in API 33; older devices auto-grant.
  if (typeof Platform.Version === "number" && Platform.Version < 33) return true;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Start the foreground service and persist the toggle to native prefs. */
export async function start(): Promise<void> {
  const native = getNative();
  if (!native) {
    throw new Error(
      "Persistent notification is not available in this build (Expo Go / iOS / missing native module).",
    );
  }
  await native.start();
}

/** Stop the foreground service and clear the persisted toggle. */
export async function stop(): Promise<void> {
  const native = getNative();
  if (!native) return;
  await native.stop();
}

/** Read the native-side persisted toggle. Source of truth on Android since
 * the BootReceiver reads from the same SharedPreferences slot. */
export async function isEnabled(): Promise<boolean> {
  const native = getNative();
  if (!native) return false;
  return native.isEnabled();
}

/**
 * Non-prompting permission check. Used on Settings mount to detect drift
 * where the native toggle says ON but the user revoked POST_NOTIFICATIONS
 * via system settings — in that case the service runs but the notification
 * is invisible, and the UI must reconcile.
 */
export async function permissionIsGranted(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (typeof Platform.Version === "number" && Platform.Version < 33) return true;
  return PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
}
