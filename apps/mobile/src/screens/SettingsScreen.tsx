import { useEffect, useMemo, useState } from "react";
import { FlatList, Platform, ScrollView, StyleSheet, View } from "react-native";
import { StorageAccessFramework } from "expo-file-system/legacy";
import {
  ActivityIndicator,
  Banner,
  Button,
  HelperText,
  IconButton,
  List,
  Modal,
  Portal,
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
  hasOmniRouteApiKey,
  saveSettings,
  setKarakeepApiKey,
  setOmniRouteApiKey,
  shouldShowMigrationBanner,
} from "../lib/settings";
import {
  captureFolderLabel,
  composeSettingsForSave,
  type FormState,
} from "../lib/settingsForm";
import { filterAndSplitModels } from "../lib/modelBrowser";
import { listModels } from "../lib/dispatcher";
import { PromptOverridesSection } from "../components/PromptOverridesSection";
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
      const [s, hasKey, hasKkKey, banner] = await Promise.all([
        getSettings(),
        hasOmniRouteApiKey(),
        hasKarakeepApiKey(),
        shouldShowMigrationBanner(),
      ]);
      // Source-of-truth for the notification toggle is native
      // SharedPreferences (BootReceiver reads it). Read the native flag if
      // available so the UI matches reality. Also reconcile: if native
      // says ON but POST_NOTIFICATIONS was revoked via system settings,
      // the service is running with an invisible notification — force-stop
      // and flip the UI off so reality matches what the user can see.
      let initialNotificationEnabled = s.persistentNotificationEnabled;
      if (captureNotification.isAvailable()) {
        try {
          const enabledNative = await captureNotification.isEnabled();
          if (enabledNative) {
            const granted = await captureNotification.permissionIsGranted();
            if (granted) {
              initialNotificationEnabled = true;
            } else {
              await captureNotification.stop();
              initialNotificationEnabled = false;
            }
          } else {
            initialNotificationEnabled = false;
          }
        } catch {
          // Native module read failed — keep the JS-side value as the hint.
        }
      }
      setForm({
        omniRouteUrl: s.omniRouteUrl,
        omniRouteModel: s.omniRouteModel,
        omniRouteVisionModel: s.omniRouteVisionModel,
        persistentNotificationEnabled: initialNotificationEnabled,
        autoTranscribeOnSave: s.autoTranscribeOnSave,
        richEditorEnabled: s.richEditorEnabled,
        previewBeforeSave: s.previewBeforeSave,
        captureFolderPath: s.captureFolderPath,
        promptOverrides: s.promptOverrides,
        karakeepUrl: s.karakeepUrl,
      });
      setKeyConfigured(hasKey);
      setKarakeepKeyConfigured(hasKkKey);
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

  const save = async () => {
    // Compose the Settings object to persist. The API keys are intentionally
    // NOT in form state — we thread the currently-stored keys through so
    // saveSettings doesn't wipe them, then write any newly-typed key
    // separately below (see composeSettingsForSave).
    //
    // Guarded end-to-end: this is the ONLY way to enter config in a no-.env
    // app, and an unguarded reject (AsyncStorage or either SecureStore write)
    // previously failed SILENTLY — worst case persisting settings while
    // dropping a newly-typed API key, so later captures fail auth with no
    // signal. Pending keys clear only after their write confirms, so a
    // failed save keeps the typed key in the field for retry.
    try {
      const existingKeys = await currentKeysOrEmpty();
      await saveSettings(composeSettingsForSave(form, existingKeys));
      if (pendingKey.length > 0) {
        await setOmniRouteApiKey(pendingKey);
        setPendingKey("");
        setKeyConfigured(true);
      }
      if (pendingKarakeepKey.length > 0) {
        await setKarakeepApiKey(pendingKarakeepKey);
        setPendingKarakeepKey("");
        setKarakeepKeyConfigured(true);
      }
      setSaved(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPickerError(`Save failed: ${msg.slice(0, 120)}`);
    }
  };

  // Both clears flip UI state only AFTER the keychain write confirms — a
  // reject must not show "cleared" while the key is still stored.
  const clearKey = async () => {
    try {
      await setOmniRouteApiKey("");
      setKeyConfigured(false);
      setPendingKey("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPickerError(`Failed to clear the key: ${msg.slice(0, 120)}`);
    }
  };

  const clearKarakeepKey = async () => {
    try {
      await setKarakeepApiKey("");
      setKarakeepKeyConfigured(false);
      setPendingKarakeepKey("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPickerError(`Failed to clear the key: ${msg.slice(0, 120)}`);
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
    if (!captureNotification.isAvailable()) {
      setPickerError(
        "Persistent notification needs a native build (Expo Go can't host it).",
      );
      return;
    }
    if (next) {
      const granted = await captureNotification.requestPermission();
      if (!granted) {
        setPickerError(
          "Notification permission denied — toggle stays off.",
        );
        return;
      }
      try {
        await captureNotification.start();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setPickerError(`Failed to start notification: ${msg.slice(0, 120)}`);
        return;
      }
    } else {
      try {
        await captureNotification.stop();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setPickerError(`Failed to stop notification: ${msg.slice(0, 120)}`);
        return;
      }
    }
    setForm({ ...form, persistentNotificationEnabled: next });
    // Self-save to AsyncStorage so a fast Save tap doesn't race with the
    // toggle's async setForm. Native SharedPreferences is the real source
    // of truth on Android, but keeping the JS hint in sync avoids a
    // confusing "Settings saved" toast that wrote the pre-flip value.
    try {
      const current = await getSettings();
      await saveSettings({
        ...current,
        persistentNotificationEnabled: next,
      });
    } catch {
      // Best-effort — reconcile-on-mount catches drift from a failed write.
    }
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
      const key = pendingKey.length > 0 ? pendingKey : stored.omniRouteApiKey;
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
      const msg = e instanceof Error ? e.message : String(e);
      // Surface via Snackbar — do NOT write the error into the path field
      // (that would persist a broken capture folder on the next Save).
      setPickerError(`Folder picker failed: ${msg.slice(0, 120)}`);
    }
  };

  const pickModel = (id: string) => {
    if (!form) return;
    if (browseTarget === "vision") {
      setForm({ ...form, omniRouteVisionModel: id });
    } else {
      setForm({ ...form, omniRouteModel: id });
    }
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
        label={keyConfigured && pendingKey.length === 0 ? "OmniRoute API key (configured)" : "OmniRoute API key"}
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder={keyConfigured ? "•••• configured — tap to replace" : "sk-..."}
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
          label={
            karakeepKeyConfigured && pendingKarakeepKey.length === 0
              ? "Karakeep API key (configured)"
              : "Karakeep API key"
          }
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={
            karakeepKeyConfigured
              ? "•••• configured — tap to replace"
              : "Generate in Karakeep → User Settings → API Keys"
          }
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

      <Portal>
        <Modal
          visible={browseOpen}
          onDismiss={() => setBrowseOpen(false)}
          contentContainerStyle={[
            styles.browseModal,
            { backgroundColor: theme.colors.surface },
          ]}
        >
          <View style={styles.browseHeader}>
            <Text variant="titleMedium">Available models</Text>
            <IconButton
              icon="close"
              onPress={() => setBrowseOpen(false)}
              accessibilityLabel="Close model browser"
            />
          </View>
          {browseLoading ? (
            <View style={styles.browseLoading}>
              <ActivityIndicator />
              <Text style={styles.browseLoadingText}>Fetching catalog…</Text>
            </View>
          ) : browseError ? (
            <View style={styles.browseBody}>
              <HelperText type="error" visible>
                {browseError}
              </HelperText>
              <Button
                mode="contained-tonal"
                onPress={() => openBrowse(browseTarget)}
              >
                Retry
              </Button>
            </View>
          ) : (
            <View style={styles.browseBody}>
              <TextInput
                {...caretProps(theme)}
                mode="outlined"
                placeholder="Filter (e.g. claude, gemini, gpt)"
                autoCapitalize="none"
                autoCorrect={false}
                value={modelFilter}
                onChangeText={setModelFilter}
                dense
              />
              <Text variant="bodySmall" style={styles.browseCount}>
                {recommended.length + others.length} model
                {recommended.length + others.length === 1 ? "" : "s"}
                {modelFilter ? ` matching “${modelFilter}”` : ""}
              </Text>
              <FlatList
                data={others}
                keyExtractor={(item) => item}
                style={styles.browseList}
                ListHeaderComponent={
                  recommended.length > 0 ? (
                    <View>
                      <List.Subheader style={styles.browseSubheader}>
                        Recommended for carnet
                      </List.Subheader>
                      {recommended.map((item) => (
                        <List.Item
                          key={item}
                          title={item}
                          titleNumberOfLines={2}
                          onPress={() => pickModel(item)}
                          style={styles.browseRow}
                          left={(p) => <List.Icon {...p} icon="star" />}
                        />
                      ))}
                      {others.length > 0 && (
                        <List.Subheader style={styles.browseSubheader}>
                          All available
                        </List.Subheader>
                      )}
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <List.Item
                    title={item}
                    titleNumberOfLines={2}
                    onPress={() => pickModel(item)}
                    style={styles.browseRow}
                  />
                )}
                ListEmptyComponent={
                  recommended.length === 0 ? (
                    <Text style={styles.browseEmpty}>No models match.</Text>
                  ) : null
                }
              />
            </View>
          )}
        </Modal>
      </Portal>
    </ScrollView>
  );
}

/** Helper that returns the currently-stored API keys if present (so
 * saveSettings doesn't wipe either when the user only changed URL/model). */
async function currentKeysOrEmpty(): Promise<{
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}> {
  const s = await getSettings();
  return {
    omniRouteApiKey: s.omniRouteApiKey ?? "",
    karakeepApiKey: s.karakeepApiKey ?? "",
    localLlmApiKey: s.localLlmApiKey ?? "",
  };
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 4 },
  save: { marginTop: 12 },
  clearKey: { alignSelf: "flex-start", marginTop: 4 },
  browseBtn: { alignSelf: "flex-start", marginTop: 4 },
  folderRow: { flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" },
  folderBtn: { alignSelf: "flex-start" },
  browseModal: {
    backgroundColor: "white",
    margin: 16,
    borderRadius: 12,
    maxHeight: "85%",
    overflow: "hidden",
  },
  browseHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 16,
  },
  browseBody: { padding: 16, gap: 8, flexShrink: 1 },
  browseList: { flexGrow: 0, maxHeight: 480 },
  browseRow: { paddingVertical: 0 },
  browseLoading: { padding: 32, alignItems: "center", gap: 8 },
  browseLoadingText: { opacity: 0.7 },
  browseCount: { opacity: 0.6, paddingHorizontal: 4 },
  browseSubheader: { paddingHorizontal: 0, paddingTop: 4 },
  browseEmpty: { textAlign: "center", opacity: 0.6, padding: 24 },
  notificationSection: { marginTop: 16 },
  notificationRow: { paddingHorizontal: 0 },
  sectionTitle: { paddingHorizontal: 0, paddingTop: 16 },
  promptSectionTitle: { paddingHorizontal: 0, paddingTop: 8 },
});
