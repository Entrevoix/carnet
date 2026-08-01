/**
 * IO orchestration for the Settings screen, extracted so the sequencing —
 * which calls happen in what order, and how failures map to user-facing
 * messages — has direct test coverage via injected stub IO. The screen keeps
 * the useState wiring; these functions only decide what to call and what
 * result to report.
 */

import {
  composeSettingsForSave,
  errorMessage,
  existingApiKeysFromSettings,
  type FormState,
} from "./settingsForm";
import type { Settings } from "./settings";

/** New key values the user typed but hasn't saved yet. Empty string means
 * "no change" for that key — mirrors the screen's pendingKey state. */
export interface PendingApiKeys {
  omniRoute: string;
  karakeep: string;
  localLlm: string;
}

/** Which pending keys `saveSettingsWithKeys` actually wrote — the caller uses
 * this to know which pending-key state to clear and which "configured" flag
 * to flip. */
export interface KeysWritten {
  omniRoute: boolean;
  karakeep: boolean;
  localLlm: boolean;
}

export interface SaveSettingsIO {
  getSettings: () => Promise<Settings>;
  saveSettings: (s: Settings) => Promise<void>;
  setOmniRouteApiKey: (key: string) => Promise<void>;
  setKarakeepApiKey: (key: string) => Promise<void>;
  setLocalLlmApiKey: (key: string) => Promise<void>;
}

export type SaveSettingsResult =
  | { ok: true; keysWritten: KeysWritten }
  | { ok: false; error: string; keysWritten: KeysWritten };

/**
 * Persist `form` plus any newly-typed API keys. Guarded end-to-end: this is
 * the ONLY way to enter config in a no-.env app, and an unguarded reject
 * (AsyncStorage or either SecureStore write) previously failed SILENTLY —
 * worst case persisting settings while dropping a newly-typed API key, so
 * later captures fail auth with no signal. A pending key is only reported as
 * written after its store confirms.
 *
 * `keysWritten` is always returned, even on `ok: false` — key writes happen
 * sequentially (OmniRoute, then Karakeep, then Local-LLM), so a later write
 * can reject after earlier ones already succeeded. The caller MUST apply
 * `keysWritten` regardless of `ok`, or a key that IS now stored (and whose
 * pending value should clear) will keep showing as unconfigured with its
 * typed value still sitting in the field.
 */
export async function saveSettingsWithKeys(
  form: FormState,
  pending: PendingApiKeys,
  io: SaveSettingsIO,
): Promise<SaveSettingsResult> {
  const keysWritten: KeysWritten = {
    omniRoute: false,
    karakeep: false,
    localLlm: false,
  };
  try {
    const currentSettings = await io.getSettings();
    const existing = existingApiKeysFromSettings(currentSettings);
    await io.saveSettings(
      composeSettingsForSave(
        form,
        existing,
        currentSettings.llmProviders,
        currentSettings.nextCustomSeq,
      ),
    );
    if (pending.omniRoute.length > 0) {
      await io.setOmniRouteApiKey(pending.omniRoute);
      keysWritten.omniRoute = true;
    }
    if (pending.karakeep.length > 0) {
      await io.setKarakeepApiKey(pending.karakeep);
      keysWritten.karakeep = true;
    }
    if (pending.localLlm.length > 0) {
      await io.setLocalLlmApiKey(pending.localLlm);
      keysWritten.localLlm = true;
    }
    return { ok: true, keysWritten };
  } catch (e: unknown) {
    return { ok: false, error: errorMessage(e, "Save failed"), keysWritten };
  }
}

/**
 * Clear a single stored API key. Shared by the OmniRoute/Karakeep/Local-LLM
 * "Clear key" buttons — each passes its own SecureStore setter. The caller
 * flips its own "configured" + pending-key state only after `ok: true`, so a
 * reject never shows "cleared" while the key is still stored.
 */
export async function clearApiKey(
  setKey: (key: string) => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await setKey("");
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: errorMessage(e, "Failed to clear the key") };
  }
}

export interface NotificationToggleIO {
  isAvailable: () => boolean;
  requestPermission: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export type NotificationToggleResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Decide + perform the native calls for flipping the persistent-capture
 * notification toggle. Turning ON requires a POST_NOTIFICATIONS grant — if
 * denied, the toggle must stay off. Turning OFF stops the service
 * immediately. Returns `ok: false` (with a user-facing message) whenever the
 * caller must NOT flip its own `persistentNotificationEnabled` state.
 */
export async function toggleNotification(
  next: boolean,
  io: NotificationToggleIO,
): Promise<NotificationToggleResult> {
  if (!io.isAvailable()) {
    return {
      ok: false,
      error:
        "Persistent notification needs a native build (Expo Go can't host it).",
    };
  }
  if (next) {
    const granted = await io.requestPermission();
    if (!granted) {
      return {
        ok: false,
        error: "Notification permission denied — toggle stays off.",
      };
    }
    try {
      await io.start();
    } catch (e: unknown) {
      return { ok: false, error: errorMessage(e, "Failed to start notification") };
    }
  } else {
    try {
      await io.stop();
    } catch (e: unknown) {
      return { ok: false, error: errorMessage(e, "Failed to stop notification") };
    }
  }
  return { ok: true };
}

export interface PersistNotificationHintIO {
  getSettings: () => Promise<Settings>;
  /**
   * MUST be settings.ts's `savePersistedOnly`, never `saveSettings`. This
   * function re-saves a `getSettings()` snapshot that may be stale by the
   * time the write lands (a POST_NOTIFICATIONS permission dialog sits
   * between the read and the write) — if that snapshot's key fields were
   * blank because a real Save raced ahead of it and wrote a key in the
   * meantime, `saveSettings` would delete that just-written key.
   * `savePersistedOnly` never touches SecureStore, so a stale snapshot here
   * can only ever affect the non-secret blob it's actually meant to touch.
   */
  savePersistedOnly: (s: Settings) => Promise<void>;
}

/**
 * Best-effort self-save of the notification hint to AsyncStorage right after
 * a successful native toggle, so a fast Save tap doesn't race with the
 * toggle's async state update. Native SharedPreferences is the real source
 * of truth on Android; a failed write here is swallowed because
 * reconcileInitialNotificationState() catches the drift on next mount.
 */
export async function persistNotificationHint(
  next: boolean,
  io: PersistNotificationHintIO,
): Promise<void> {
  try {
    const current = await io.getSettings();
    await io.savePersistedOnly({ ...current, persistentNotificationEnabled: next });
  } catch {
    // Best-effort — reconcile-on-mount catches drift from a failed write.
  }
}

export interface NotificationReconcileInput {
  /** The JS-side persisted hint from the settings blob. */
  jsHint: boolean;
  /** Whether the native CaptureNotification module is available in this build. */
  nativeAvailable: boolean;
  /** Native-side persisted toggle (BootReceiver's source of truth). */
  enabledNative: boolean;
  /** Whether POST_NOTIFICATIONS is currently granted (only meaningful when enabledNative). */
  permissionGranted: boolean;
}

export interface NotificationReconcileResult {
  /** The value the caller should show/store as persistentNotificationEnabled. */
  value: boolean;
  /** True if the native service must be force-stopped to match `value`. */
  shouldStopNative: boolean;
}

/**
 * Reconcile the notification toggle's initial value on Settings mount.
 * Source-of-truth for the toggle is native SharedPreferences (BootReceiver
 * reads it there), so the JS hint is only used when the native module isn't
 * available at all. If native says ON but POST_NOTIFICATIONS was revoked via
 * system settings, the service is running with an invisible notification —
 * the toggle must show OFF and the caller must force-stop the service so
 * reality matches what the user can see.
 */
export function reconcileInitialNotificationState(
  input: NotificationReconcileInput,
): NotificationReconcileResult {
  if (!input.nativeAvailable) {
    return { value: input.jsHint, shouldStopNative: false };
  }
  if (!input.enabledNative) {
    return { value: false, shouldStopNative: false };
  }
  if (input.permissionGranted) {
    return { value: true, shouldStopNative: false };
  }
  return { value: false, shouldStopNative: true };
}
