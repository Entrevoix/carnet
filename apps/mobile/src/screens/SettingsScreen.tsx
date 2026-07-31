import { useEffect, useMemo, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { StorageAccessFramework } from "expo-file-system/legacy";
import {
  Banner,
  Button,
  HelperText,
  List,
  SegmentedButtons,
  Snackbar,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";

import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  dismissMigrationBanner,
  getSettings,
  hasKarakeepApiKey,
  hasLocalLlmApiKey,
  hasOmniRouteApiKey,
  saveSettings,
  setKarakeepApiKey,
  setLocalLlmApiKey,
  setOmniRouteApiKey,
  shouldShowMigrationBanner,
} from "../lib/settings";
import {
  apiKeyFieldLabel,
  apiKeyFieldPlaceholder,
  captureFolderLabel,
  errorMessage,
  formStateFromSettings,
  type FormState,
} from "../lib/settingsForm";
import {
  applyPickedModel,
  filterAndSplitModels,
  resolveBrowseApiKey,
} from "../lib/modelBrowser";
import {
  clearApiKey,
  persistNotificationHint,
  reconcileInitialNotificationState,
  saveSettingsWithKeys,
  toggleNotification,
} from "../lib/settingsPersistence";
import { listModels } from "../lib/dispatcher";
import { healthCheck } from "../lib/localLlm";
import { PromptOverridesSection } from "../components/PromptOverridesSection";
import { DiagnosticsSection } from "../components/DiagnosticsSection";
import { ModelBrowserModal } from "../components/ModelBrowserModal";
import { LocalLlmSection } from "../components/LocalLlmSection";
import { caretProps, spacing, useCarnetTheme } from "../lib/theme";
import {
  useThemePreference,
  type ThemePreference,
} from "../lib/themePreference";
import * as captureNotification from "../lib/captureNotification";
import { VoiceSetupCheck } from "../voice/VoiceSetupCheck";

/**
 * Pinned at the top of the model browser. Verified-working chat models on
 * llm.grepon.cc for carnet's structured-markdown use case — the catalog also
 * contains embeddings, image gen, and broken upstream routes the user has no
 * reason to click. Order is rough quality/cost tradeoff.
 */
const RECOMMENDED_MODELS = [
  "gemini/gemini-2.5-flash-lite",
  "gemini/gemini-2.5-flash",
  "claude/claude-haiku-4-5-20251001",
  "claude/claude-sonnet-4-6",
] as const;

export default function SettingsScreen() {
  const theme = useCarnetTheme();
  const themePreference = useThemePreference();
  const [form, setForm] = useState<FormState | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean>(false);
  /** Holds a NEW API key the user is entering. Empty string means "no change". */
  const [pendingKey, setPendingKey] = useState<string>("");
  /** Karakeep key state — mirrors the OmniRoute key pattern. The key is never
   * read into render state; we only track whether one is configured and any
   * newly-typed replacement. */
  const [karakeepKeyConfigured, setKarakeepKeyConfigured] =
    useState<boolean>(false);
  const [pendingKarakeepKey, setPendingKarakeepKey] = useState<string>("");
  /** Local-LLM key state — mirrors the OmniRoute/Karakeep key pattern. */
  const [localLlmKeyConfigured, setLocalLlmKeyConfigured] = useState<boolean>(false);
  const [pendingLocalLlmKey, setPendingLocalLlmKey] = useState<string>("");
  /** Test Connection state for the Local LLM section. */
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<"ok" | "unreachable" | null>(null);
  const [saved, setSaved] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  /** Surfaced via Snackbar when the SAF folder picker fails. Previous
   * behavior wrote "error: ..." into the path field, which then got
   * persisted on Save as a broken capture folder. */
  const [pickerError, setPickerError] = useState<string | null>(null);

  // Model browser state — opens a modal that lists available models from
  // GET /v1/models so the user can pick from the actual catalog instead of
  // guessing a model name.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  // Which model field the browser is picking for — the same modal drives both
  // the chat and the vision picker so the listModels catalog is fetched once
  // per open and routed to the right form field on select.
  const [browseTarget, setBrowseTarget] = useState<"chat" | "vision">("chat");

  // useMemo MUST run on every render in the same order — must live above
  // the `if (!form) return …` early return below, or hook count changes
  // between renders and React throws "Rendered more hooks than…".
  const { recommended, others } = useMemo(
    () => filterAndSplitModels(models, modelFilter, RECOMMENDED_MODELS),
    [models, modelFilter],
  );

  useEffect(() => {
    void (async () => {
      const [s, hasKey, hasKkKey, hasLocalKey, banner] = await Promise.all([
        getSettings(),
        hasOmniRouteApiKey(),
        hasKarakeepApiKey(),
        hasLocalLlmApiKey(),
        shouldShowMigrationBanner(),
      ]);
      // Source-of-truth for the notification toggle is native
      // SharedPreferences (BootReceiver reads it) — reconcileInitialNotificationState
      // decides the value; force-stop happens here if it says the invisible-
      // notification case (native ON, permission revoked) applies.
      let initialNotificationEnabled = s.persistentNotificationEnabled;
      const nativeAvailable = captureNotification.isAvailable();
      if (nativeAvailable) {
        try {
          const enabledNative = await captureNotification.isEnabled();
          const permissionGranted = enabledNative
            ? await captureNotification.permissionIsGranted()
            : false;
          const reconciled = reconcileInitialNotificationState({
            jsHint: initialNotificationEnabled,
            nativeAvailable,
            enabledNative,
            permissionGranted,
          });
          initialNotificationEnabled = reconciled.value;
          if (reconciled.shouldStopNative) {
            await captureNotification.stop();
          }
        } catch {
          // Native module read failed — keep the JS-side value as the hint.
        }
      }
      setForm(formStateFromSettings(s, initialNotificationEnabled));
      setKeyConfigured(hasKey);
      setKarakeepKeyConfigured(hasKkKey);
      setLocalLlmKeyConfigured(hasLocalKey);
      setShowBanner(banner);
    })();
  }, []);

  if (!form) {
    return (
      <View style={styles.loading}>
        <Text>Loading…</Text>
      </View>
    );
  }

  const update = (patch: Partial<FormState>) => {
    setForm({ ...form, ...patch });
  };

  // API keys are intentionally NOT in form state — saveSettingsWithKeys
  // threads the currently-stored keys through so saveSettings doesn't wipe
  // them, then writes any newly-typed key. See settingsPersistence.ts for
  // the guarded-end-to-end rationale (this is the ONLY way to enter config
  // in a no-.env app).
  const save = async () => {
    const result = await saveSettingsWithKeys(
      form,
      {
        omniRoute: pendingKey,
        karakeep: pendingKarakeepKey,
        localLlm: pendingLocalLlmKey,
      },
      { getSettings, saveSettings, setOmniRouteApiKey, setKarakeepApiKey, setLocalLlmApiKey },
    );
    if (!result.ok) {
      setPickerError(result.error);
      return;
    }
    if (result.keysWritten.omniRoute) {
      setPendingKey("");
      setKeyConfigured(true);
    }
    if (result.keysWritten.karakeep) {
      setPendingKarakeepKey("");
      setKarakeepKeyConfigured(true);
    }
    if (result.keysWritten.localLlm) {
      setPendingLocalLlmKey("");
      setLocalLlmKeyConfigured(true);
    }
    setSaved(true);
  };

  // Each clear flips UI state only AFTER the keychain write confirms — a
  // reject must not show "cleared" while the key is still stored.
  const clearKey = async () => {
    const result = await clearApiKey(setOmniRouteApiKey);
    if (result.ok) {
      setKeyConfigured(false);
      setPendingKey("");
    } else {
      setPickerError(result.error);
    }
  };

  const clearKarakeepKey = async () => {
    const result = await clearApiKey(setKarakeepApiKey);
    if (result.ok) {
      setKarakeepKeyConfigured(false);
      setPendingKarakeepKey("");
    } else {
      setPickerError(result.error);
    }
  };

  const clearLocalLlmKey = async () => {
    const result = await clearApiKey(setLocalLlmApiKey);
    if (result.ok) {
      setLocalLlmKeyConfigured(false);
      setPendingLocalLlmKey("");
    } else {
      setPickerError(result.error);
    }
  };

  /**
   * Atomic toggle for the persistent capture notification. Turning ON
   * requires POST_NOTIFICATIONS grant — if denied, the toggle stays off
   * and the user sees a snackbar. Turning OFF stops the service
   * immediately. Form state is updated only after the native call
   * succeeds so the UI never lies about what's actually running.
   */
  const handleToggleNotification = async (next: boolean) => {
    if (!form) return;
    const result = await toggleNotification(next, captureNotification);
    if (!result.ok) {
      setPickerError(result.error);
      return;
    }
    setForm({ ...form, persistentNotificationEnabled: next });
    await persistNotificationHint(next, { getSettings, saveSettings });
  };

  const handleDismissBanner = async () => {
    await dismissMigrationBanner();
    setShowBanner(false);
  };

  /** Open the model browser. Uses the URL from form state and the API key
   * from SecureStore (via getSettings) — or the freshly-typed pendingKey
   * if the user hasn't saved it yet. */
  const openBrowse = async (target: "chat" | "vision" = "chat") => {
    if (!form) return;
    setBrowseTarget(target);
    setBrowseError(null);
    setBrowseOpen(true);
    setModelFilter("");
    // Refetch every open — the user may have changed URL/key since last time.
    setBrowseLoading(true);
    try {
      const stored = await getSettings();
      const key = resolveBrowseApiKey(pendingKey, stored.omniRouteApiKey);
      const list = await listModels(form.omniRouteUrl, key);
      setModels(list);
    } catch (e: unknown) {
      setBrowseError(e instanceof Error ? e.message : String(e));
      setModels(null);
    } finally {
      setBrowseLoading(false);
    }
  };

  /**
   * Open Android's Storage Access Framework folder picker. Returns a
   * `content://...tree/...` URI the OS has granted persistent permission
   * to. Typically the user picks their Syncthing-watched folder so
   * captures land where the workstation can see them.
   *
   * iOS has no SAF equivalent; the text field is the only path there.
   * Carnet is Android-first per the README.
   */
  const pickCaptureFolder = async () => {
    if (!form) return;
    if (Platform.OS !== "android") return;
    try {
      const res = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (res.granted && res.directoryUri) {
        setForm({ ...form, captureFolderPath: res.directoryUri });
      }
    } catch (e: unknown) {
      // Surface via Snackbar — do NOT write the error into the path field
      // (that would persist a broken capture folder on the next Save).
      setPickerError(errorMessage(e, "Folder picker failed"));
    }
  };

  const testLocalLlmConnection = async () => {
    if (!form) return;
    setTestingConnection(true);
    setConnectionResult(null);
    const ok = await healthCheck(form.localLlmUrl);
    setConnectionResult(ok ? "ok" : "unreachable");
    setTestingConnection(false);
  };

  const pickModel = (id: string) => {
    if (!form) return;
    setForm(applyPickedModel(form, browseTarget, id));
    setBrowseOpen(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Banner
        visible={showBanner}
        actions={[
          {
            label: "OK, got it",
            onPress: handleDismissBanner,
          },
        ]}
        icon="information"
      >
        navetted has been replaced by OmniRoute. Configure your OmniRoute key
        below to continue capturing.
      </Banner>

      {/* Appearance — light/dark follows the OS unless pinned here. Applies
          instantly (no Save tap); persisted via themePreference, not the
          settings blob, so App.tsx can read it at cold start. */}
      <Text variant="titleMedium">Appearance</Text>
      <SegmentedButtons
        value={themePreference.preference}
        onValueChange={(v) =>
          themePreference.setPreference(v as ThemePreference)
        }
        buttons={[
          { value: "system", label: "System", icon: "theme-light-dark" },
          { value: "light", label: "Light", icon: "white-balance-sunny" },
          { value: "dark", label: "Dark", icon: "weather-night" },
        ]}
        style={{ marginBottom: spacing.sm }}
      />

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Enrichment backend
      </Text>
      <HelperText type="info" visible>
        Where AI enrichment runs. OmniRoute is your self-hosted cloud-routed
        proxy; Local runs entirely on-device (or LAN) with no internet
        required.
      </HelperText>
      <SegmentedButtons
        value={form.llmBackend}
        onValueChange={(v) => update({ llmBackend: v as FormState["llmBackend"] })}
        buttons={[
          { value: "omniroute", label: "OmniRoute", icon: "cloud-outline" },
          { value: "local", label: "Local", icon: "cellphone-off" },
        ]}
        style={{ marginBottom: spacing.sm }}
      />

      {form.llmBackend === "omniroute" && (
        <>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Connection
          </Text>
          <HelperText type="info" visible>
            Where AI enrichment runs — your self-hosted OmniRoute endpoint.
          </HelperText>
          <TextInput
            {...caretProps(theme)}
            label="OmniRoute URL"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={form.omniRouteUrl}
            onChangeText={(v) => update({ omniRouteUrl: v })}
          />
          <HelperText type="info" visible>
            OmniRoute base URL — must start with https:// (e.g. https://llm.grepon.cc)
          </HelperText>

          <TextInput
            {...caretProps(theme)}
            label={apiKeyFieldLabel("OmniRoute API key", keyConfigured, pendingKey.length)}
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={apiKeyFieldPlaceholder(keyConfigured, "sk-...")}
            value={pendingKey}
            onChangeText={setPendingKey}
          />
          <HelperText type="info" visible>
            Stored in the secure keychain. The existing key is never shown again.
          </HelperText>
          {keyConfigured && (
            <Button mode="text" compact onPress={clearKey} style={styles.clearKey}>
              Clear key
            </Button>
          )}

          <TextInput
            {...caretProps(theme)}
            label="Model"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            value={form.omniRouteModel}
            onChangeText={(v) => update({ omniRouteModel: v })}
            placeholder={DEFAULT_OMNIROUTE_MODEL}
          />
          <HelperText type="info" visible>
            OmniRoute model — tap Browse to pick from your provider's catalog
          </HelperText>
          <Button
            mode="text"
            icon="format-list-bulleted"
            compact
            onPress={() => openBrowse("chat")}
            disabled={!form.omniRouteUrl.trim()}
            style={styles.browseBtn}
          >
            Browse available models
          </Button>

          <TextInput
            {...caretProps(theme)}
            label="Vision model"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            value={form.omniRouteVisionModel}
            onChangeText={(v) => update({ omniRouteVisionModel: v })}
            placeholder={DEFAULT_VISION_MODEL}
          />
          <HelperText type="info" visible>
            Vision-capable model used when you share a photo or image into carnet.
            Held separate from the chat model so a text-only model can't silently
            drop the image. Must handle image input (e.g. gpt-4o-mini, Gemini
            Flash, Claude). Tap Browse to pick from your provider's catalog.
          </HelperText>
          <Button
            mode="text"
            icon="format-list-bulleted"
            compact
            onPress={() => openBrowse("vision")}
            disabled={!form.omniRouteUrl.trim()}
            style={styles.browseBtn}
          >
            Browse available models
          </Button>
        </>
      )}

      {form.llmBackend === "local" && (
        <LocalLlmSection
          theme={theme}
          url={form.localLlmUrl}
          onUrlChange={(v) => update({ localLlmUrl: v })}
          keyConfigured={localLlmKeyConfigured}
          pendingKey={pendingLocalLlmKey}
          onPendingKeyChange={setPendingLocalLlmKey}
          onClearKey={clearLocalLlmKey}
          model={form.localLlmModel}
          onModelChange={(v) => update({ localLlmModel: v })}
          testingConnection={testingConnection}
          connectionResult={connectionResult}
          onTestConnection={() => void testLocalLlmConnection()}
        />
      )}

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Storage
      </Text>
      <HelperText type="info" visible>
        Where notes are saved — point this at your Syncthing-watched vault
        folder so captures sync to your workstation.
      </HelperText>
      <TextInput
        {...caretProps(theme)}
        label="Capture folder"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={captureFolderLabel(form.captureFolderPath)}
        onChangeText={(v) => update({ captureFolderPath: v })}
        placeholder="(app sandbox folder by default)"
      />
      <HelperText type="info" visible>
        Tap Pick folder to choose via the Android system picker, or type a
        path directly (e.g. /storage/emulated/0/carnet). Carnet will create
        Ideas/, Journal/, People/, Photos/ directly inside the chosen folder
        — pick the folder you want those to live in, not the parent.
      </HelperText>
      <View style={styles.folderRow}>
        <Button
          mode="text"
          icon="folder-open"
          compact
          onPress={pickCaptureFolder}
          style={styles.folderBtn}
        >
          Pick folder
        </Button>
        {form.captureFolderPath.length > 0 && (
          <Button
            mode="text"
            compact
            onPress={() => update({ captureFolderPath: "" })}
            style={styles.folderBtn}
          >
            Reset to default
          </Button>
        )}
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Karakeep
        </Text>
        <HelperText type="info" visible>
          Export notes to a self-hosted Karakeep instance. Leave the URL blank
          to hide the "Send to Karakeep" action.
        </HelperText>
        <TextInput
          {...caretProps(theme)}
          label="Karakeep URL"
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={form.karakeepUrl}
          onChangeText={(v) => update({ karakeepUrl: v })}
        />
        <HelperText type="info" visible>
          Karakeep base URL — must start with https:// (e.g.
          https://karakeep.example.com). The /api/v1 path is added automatically.
        </HelperText>

        <TextInput
          {...caretProps(theme)}
          label={apiKeyFieldLabel(
            "Karakeep API key",
            karakeepKeyConfigured,
            pendingKarakeepKey.length,
          )}
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={apiKeyFieldPlaceholder(
            karakeepKeyConfigured,
            "Generate in Karakeep → User Settings → API Keys",
          )}
          value={pendingKarakeepKey}
          onChangeText={setPendingKarakeepKey}
        />
        <HelperText type="info" visible>
          Stored in the secure keychain. The existing key is never shown again.
        </HelperText>
        {karakeepKeyConfigured && (
          <Button
            mode="text"
            compact
            onPress={clearKarakeepKey}
            style={styles.clearKey}
          >
            Clear key
          </Button>
        )}
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          AI behavior
        </Text>
        <List.Item
          title="Auto-transcribe audio on save"
          description={
            form.autoTranscribeOnSave
              ? "Every audio capture is transcribed on-device automatically"
              : "Off — tap Transcribe per note instead"
          }
          left={(p) => <List.Icon {...p} icon="text-recognition" />}
          right={() => (
            <Switch
              value={form.autoTranscribeOnSave}
              onValueChange={(next) =>
                update({ autoTranscribeOnSave: next })
              }
            />
          )}
          style={styles.notificationRow}
        />
        <HelperText type="info" visible>
          Doubles the OmniRoute API spend per audio capture. Skip if you only
          transcribe occasionally.
        </HelperText>
        <List.Item
          title="Preview ideas before saving"
          description={
            form.previewBeforeSave
              ? "Idea captures wait for enrichment, then you review + Save"
              : "Off — ideas save instantly and enrich in the background"
          }
          left={(p) => <List.Icon {...p} icon="eye-check" />}
          right={() => (
            <Switch
              value={form.previewBeforeSave}
              onValueChange={(next) => update({ previewBeforeSave: next })}
            />
          )}
          style={styles.notificationRow}
        />
        <HelperText type="info" visible>
          Default off: an idea is written to your vault the moment you tap Save,
          and the AI structures it afterwards. Turn on to vet the AI's version
          before it lands. Contacts always preview regardless of this setting.
        </HelperText>
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Voice input
        </Text>
        <HelperText type="info" visible>
          On-device dictation needs Google's English voice model. Check whether
          it's installed and pull it from inside the app — no Play Store trip.
        </HelperText>
        <VoiceSetupCheck />
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Capture surfaces
        </Text>
        <List.Item
          title="Persistent capture notification"
          description={
            form.persistentNotificationEnabled
              ? "Always-on quick-capture row in the notification shade"
              : "Off — turn on for one-tap capture from anywhere"
          }
          left={(p) => <List.Icon {...p} icon="bell-ring-outline" />}
          right={() => (
            <Switch
              value={form.persistentNotificationEnabled}
              onValueChange={handleToggleNotification}
              disabled={!captureNotification.isAvailable()}
            />
          )}
          style={styles.notificationRow}
        />
        {!captureNotification.isAvailable() ? (
          <HelperText type="info" visible>
            Requires a native build — rebuild via `npm run android` to enable.
          </HelperText>
        ) : null}
      </View>

      <PromptOverridesSection
        overrides={form.promptOverrides}
        onChange={(next) => update({ promptOverrides: next })}
      />

      <DiagnosticsSection />

      <Button mode="contained" onPress={save} style={styles.save}>
        Save
      </Button>

      <Snackbar
        visible={saved}
        onDismiss={() => setSaved(false)}
        duration={2500}
      >
        Settings saved
      </Snackbar>

      <Snackbar
        visible={pickerError !== null}
        onDismiss={() => setPickerError(null)}
        duration={5000}
      >
        {pickerError ?? ""}
      </Snackbar>

      <ModelBrowserModal
        theme={theme}
        visible={browseOpen}
        onDismiss={() => setBrowseOpen(false)}
        loading={browseLoading}
        error={browseError}
        onRetry={() => openBrowse(browseTarget)}
        filter={modelFilter}
        onFilterChange={setModelFilter}
        recommended={recommended}
        others={others}
        onPickModel={pickModel}
      />
    </ScrollView>
  );
}


const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 4 },
  save: { marginTop: 12 },
  clearKey: { alignSelf: "flex-start", marginTop: 4 },
  browseBtn: { alignSelf: "flex-start", marginTop: 4 },
  folderRow: { flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" },
  folderBtn: { alignSelf: "flex-start" },
  notificationSection: { marginTop: 16 },
  notificationRow: { paddingHorizontal: 0 },
  sectionTitle: { paddingHorizontal: 0, paddingTop: 16 },
  promptSectionTitle: { paddingHorizontal: 0, paddingTop: 8 },
});
