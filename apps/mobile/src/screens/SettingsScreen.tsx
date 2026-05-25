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
  Snackbar,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";

import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  dismissMigrationBanner,
  getSettings,
  hasOmniRouteApiKey,
  type PromptOverrides,
  saveSettings,
  setOmniRouteApiKey,
  shouldShowMigrationBanner,
  type Settings,
} from "../lib/settings";
import { listModels } from "../lib/omniroute";
import * as captureNotification from "../lib/captureNotification";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
} from "../lib/prompts";

const PROMPT_MODES = [
  { key: "idea", label: "Idea", icon: "lightbulb-on" },
  { key: "journal", label: "Journal", icon: "microphone" },
  { key: "person", label: "Contact", icon: "account" },
  { key: "sharedImage", label: "Photo + Image", icon: "camera" },
  { key: "sharedLink", label: "Link + Text", icon: "link" },
] as const;

type PromptModeKey = (typeof PROMPT_MODES)[number]["key"];

/** Render the default system prompt for a mode by invoking the builder
 * with placeholder args. Used to populate the "Copy default" button so
 * the user has a starting point for tweaking. */
function defaultPromptFor(mode: PromptModeKey): string {
  switch (mode) {
    case "idea":
      return buildIdeaPrompt("placeholder").system;
    case "journal":
      return buildJournalPrompt("placeholder", "").system;
    case "person":
      return buildPersonPrompt("placeholder", "").system;
    case "sharedImage":
      return buildSharedImagePrompt("").system;
    case "sharedLink":
      return buildSharedLinkPrompt("", "", "", null).system;
  }
}

interface FormState {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteTranscriptionModel: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
}

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
  const [form, setForm] = useState<FormState | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean>(false);
  /** Holds a NEW API key the user is entering. Empty string means "no change". */
  const [pendingKey, setPendingKey] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  /** Surfaced via Snackbar when the SAF folder picker fails. Previous
   * behavior wrote "error: ..." into the path field, which then got
   * persisted on Save as a broken capture folder. */
  const [pickerError, setPickerError] = useState<string | null>(null);

  // Prompt-override editor: which row is open. Null = all collapsed.
  // Selection is screen-local; nothing is persisted about UI state.
  const [expandedPromptMode, setExpandedPromptMode] =
    useState<PromptModeKey | null>(null);

  // Model browser state — opens a modal that lists available models from
  // GET /v1/models so the user can pick from the actual catalog instead of
  // guessing a model name.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelFilter, setModelFilter] = useState("");

  // useMemo MUST run on every render in the same order — must live above
  // the `if (!form) return …` early return below, or hook count changes
  // between renders and React throws "Rendered more hooks than…".
  const { recommended, others } = useMemo(() => {
    if (!models) return { recommended: [], others: [] as string[] };
    const q = modelFilter.trim().toLowerCase();
    const matches = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
    const recSet = new Set<string>(RECOMMENDED_MODELS);
    const rec = RECOMMENDED_MODELS.filter((m) => matches.includes(m));
    const rest = matches.filter((m) => !recSet.has(m));
    return { recommended: rec as string[], others: rest };
  }, [models, modelFilter]);

  useEffect(() => {
    void (async () => {
      const [s, hasKey, banner] = await Promise.all([
        getSettings(),
        hasOmniRouteApiKey(),
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
        omniRouteTranscriptionModel: s.omniRouteTranscriptionModel,
        persistentNotificationEnabled: initialNotificationEnabled,
        autoTranscribeOnSave: s.autoTranscribeOnSave,
        captureFolderPath: s.captureFolderPath,
        promptOverrides: s.promptOverrides,
      });
      setKeyConfigured(hasKey);
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
    // Compose a Settings object. The API key is intentionally NOT read into
    // form state — we only write it if the user typed a new one OR cleared it.
    const next: Settings = {
      omniRouteUrl: form.omniRouteUrl,
      omniRouteModel: form.omniRouteModel || DEFAULT_OMNIROUTE_MODEL,
      omniRouteTranscriptionModel:
        form.omniRouteTranscriptionModel || DEFAULT_TRANSCRIPTION_MODEL,
      persistentNotificationEnabled: form.persistentNotificationEnabled,
      autoTranscribeOnSave: form.autoTranscribeOnSave,
      // Pass an empty string here so saveSettings doesn't touch the key.
      // Then we handle the key write separately below.
      omniRouteApiKey: "",
      captureFolderPath: form.captureFolderPath,
      promptOverrides: form.promptOverrides,
    };
    // Save URL / model / folder via saveSettings, but skip the key write
    // by re-reading the key state inside this scope (we don't have the key
    // in form state). Use setOmniRouteApiKey only when the user typed one.
    await saveSettings({ ...next, omniRouteApiKey: await currentKeyOrEmpty() });
    if (pendingKey.length > 0) {
      await setOmniRouteApiKey(pendingKey);
      setPendingKey("");
      setKeyConfigured(true);
    }
    setSaved(true);
  };

  const clearKey = async () => {
    await setOmniRouteApiKey("");
    setKeyConfigured(false);
    setPendingKey("");
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
  const openBrowse = async () => {
    if (!form) return;
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

  /** Best-effort human-readable label for a `content://` tree URI. SAF
   * URIs look like `content://com.android.externalstorage.documents/tree/primary%3AObsidian%2FCarnet`
   * — show the tail after `tree/` decoded so the user sees `primary:Obsidian/Carnet`. */
  const captureFolderLabel = (raw: string): string => {
    if (!raw) return "";
    if (!raw.startsWith("content://")) return raw;
    try {
      const decoded = decodeURIComponent(raw);
      const idx = decoded.lastIndexOf("tree/");
      if (idx >= 0) return decoded.slice(idx + 5);
      return decoded;
    } catch {
      return raw;
    }
  };

  const pickModel = (id: string) => {
    if (!form) return;
    setForm({ ...form, omniRouteModel: id });
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

      <TextInput
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
        onPress={openBrowse}
        disabled={!form.omniRouteUrl.trim()}
        style={styles.browseBtn}
      >
        Browse available models
      </Button>

      <TextInput
        label="Transcription model"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={form.omniRouteTranscriptionModel}
        onChangeText={(v) => update({ omniRouteTranscriptionModel: v })}
        placeholder={DEFAULT_TRANSCRIPTION_MODEL}
      />
      <HelperText type="info" visible>
        Whisper-compatible model for audio note transcription. Most OmniRoute
        proxies expose whisper-1; self-hosted may need a prefix like
        openai/whisper-1.
      </HelperText>

      <TextInput
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
          AI behavior
        </Text>
        <List.Item
          title="Auto-transcribe audio on save"
          description={
            form.autoTranscribeOnSave
              ? "Every audio capture runs through Whisper automatically"
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

      <View style={styles.promptSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Prompt overrides
        </Text>
        <HelperText type="info" visible>
          Override how OmniRoute structures each capture mode. Leave a section
          empty to use the default. Removing the frontmatter format or
          injection guard can drop captures to a stub note — use "Reset to
          default" to recover.
        </HelperText>
        {PROMPT_MODES.map(({ key, label, icon }) => {
          const isExpanded = expandedPromptMode === key;
          const value = form.promptOverrides[key] ?? "";
          const isCustomized = value.trim().length > 0;
          return (
            <View key={key}>
              <List.Item
                title={label}
                description={isCustomized ? "customized" : "using default"}
                left={(p) => <List.Icon {...p} icon={icon} />}
                right={(p) => (
                  <List.Icon
                    {...p}
                    icon={isExpanded ? "chevron-up" : "chevron-down"}
                  />
                )}
                onPress={() =>
                  setExpandedPromptMode(isExpanded ? null : key)
                }
                style={styles.promptRow}
              />
              {isExpanded ? (
                <View style={styles.promptEditor}>
                  <TextInput
                    mode="outlined"
                    multiline
                    numberOfLines={10}
                    value={value}
                    onChangeText={(v) =>
                      update({
                        promptOverrides: {
                          ...form.promptOverrides,
                          [key]: v,
                        },
                      })
                    }
                    placeholder="(empty — using the default. Tap Copy default to start editing)"
                    style={styles.promptInput}
                  />
                  <View style={styles.promptActions}>
                    <Button
                      mode="text"
                      compact
                      onPress={() =>
                        update({
                          promptOverrides: {
                            ...form.promptOverrides,
                            [key]: defaultPromptFor(key),
                          },
                        })
                      }
                    >
                      Copy default
                    </Button>
                    {isCustomized ? (
                      <Button
                        mode="text"
                        compact
                        onPress={() =>
                          update({
                            promptOverrides: {
                              ...form.promptOverrides,
                              [key]: "",
                            },
                          })
                        }
                      >
                        Reset to default
                      </Button>
                    ) : null}
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

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
          contentContainerStyle={styles.browseModal}
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
              <Button mode="contained-tonal" onPress={openBrowse}>
                Retry
              </Button>
            </View>
          ) : (
            <View style={styles.browseBody}>
              <TextInput
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

/** Helper that returns the currently-stored API key if present (so
 * saveSettings doesn't wipe it when the user only changed URL/model). */
async function currentKeyOrEmpty(): Promise<string> {
  const s = await getSettings();
  return s.omniRouteApiKey ?? "";
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
  promptSection: { marginTop: 16 },
  promptSectionTitle: { paddingHorizontal: 0, paddingTop: 8 },
  promptRow: { paddingHorizontal: 0 },
  promptEditor: { paddingHorizontal: 0, paddingBottom: 8, gap: 4 },
  promptInput: { fontFamily: "monospace" },
  promptActions: { flexDirection: "row", gap: 8 },
});
