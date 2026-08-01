import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Dialog,
  HelperText,
  List,
  Portal,
  Text,
  TextInput,
} from "react-native-paper";

import { getSettings, savePersistedOnly, type Settings } from "../lib/settings";
import {
  addCustomProvider,
  resolveActiveProvider,
  validateProvider,
  type LlmProvider,
} from "../lib/llmProviders";
import * as providerKeys from "../lib/providerKeys";
import { healthCheck, type HealthResult } from "../lib/llmClient";
import { listModels } from "../lib/dispatcher";
import {
  filterAndSplitModels,
  resolveBrowseApiKey,
  RECOMMENDED_MODELS,
} from "../lib/modelBrowser";
import {
  applyEditBuffer,
  applyPickedModelToBuffer,
  editBufferFromProvider,
  reassignIdentityAfterDelete,
  type EditBuffer,
} from "../lib/llmProviderForm";
import { apiKeyFieldLabel, apiKeyFieldPlaceholder, errorMessage } from "../lib/settingsForm";
import { ModelBrowserModal } from "./ModelBrowserModal";
import { ProviderPickerModal } from "./ProviderPickerModal";
import { caretProps, spacing, type CarnetTheme } from "../lib/theme";

interface LlmProviderSectionProps {
  theme: CarnetTheme;
  /** Surfaces a failed IO operation via the parent's own error Snackbar —
   * this section deliberately has no error UI of its own (see the header
   * doc for why: everything here persists immediately, unlike the rest of
   * Settings' explicit-Save fields, so failures need the same "surface it
   * now" treatment the screen already gives folder-picker/notification
   * failures). */
  onError: (message: string) => void;
}

/** Which identity id the open ProviderPickerModal is selecting for. `null`
 * means the modal is closed. */
type PickerMode = "active" | "fallback" | "vision";

/**
 * Settings → LLM provider (Phase 4 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI"). The
 * only place in Settings that reaches `llmProviders`/`activeProviderId`/
 * `nextCustomSeq`/`fallbackProviderId`/`visionProviderId`.
 *
 * Unlike PromptOverridesSection/LocalLlmSection (parent-owned form state,
 * saved by the screen's one Save button), this section owns its OWN reads
 * and writes end-to-end — every structural action (switching the active
 * provider, adding/deleting a custom entry, changing the fallback/vision
 * selection) persists immediately, the same way the notification toggle and
 * DiagnosticsSection's clear-log button already do elsewhere on this screen.
 * That is a deliberate choice, not an oversight: deleting a provider must
 * delete its SecureStore key AND reassign any dangling active/fallback/
 * vision id in the SAME write (see llmProviderForm.ts's
 * reassignIdentityAfterDelete) — a change too atomic to defer behind a
 * separate Save tap without a window where the two could desync.
 *
 * Only the currently-selected (= active) entry's text fields (label, base
 * URL, model, vision model) use a local edit buffer with an explicit "Save
 * provider" button, matching the rest of Settings' typed-then-saved pattern
 * for text inputs — the difference is scoped to fields that would be noisy
 * to persist on every keystroke, not to the identity/list operations above.
 *
 * API keys go through `providerKeys.ts` exclusively (never AsyncStorage,
 * never the settings blob) — including for `omniroute`/`relais`, whose keys
 * providerKeys.ts transparently aliases to the SAME SecureStore entries
 * `lib/settings.ts`'s legacy setOmniRouteApiKey/setLocalLlmApiKey used, so
 * there is no dual-write or migration to worry about here.
 */
export function LlmProviderSection({ theme, onError }: LlmProviderSectionProps) {
  const [providers, setProviders] = useState<LlmProvider[] | null>(null);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [fallbackProviderId, setFallbackProviderId] = useState<string | null>(null);
  const [visionProviderId, setVisionProviderId] = useState<string | null>(null);
  const [nextCustomSeq, setNextCustomSeq] = useState(1);

  const [editBuffer, setEditBuffer] = useState<EditBuffer>({
    label: "",
    baseUrl: "",
    model: "",
    visionModel: "",
  });
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [pendingKey, setPendingKey] = useState("");

  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<HealthResult | null>(null);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [browseTarget, setBrowseTarget] = useState<"chat" | "vision">("chat");

  // useMemo MUST run on every render in the same order — above the
  // `if (providers === null) return null` below (mirrors SettingsScreen's
  // own top-level useMemo for the same reason).
  const { recommended, others } = useMemo(
    () => filterAndSplitModels(models, modelFilter, RECOMMENDED_MODELS),
    [models, modelFilter],
  );

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setProviders(s.llmProviders);
      setActiveProviderId(s.activeProviderId);
      setFallbackProviderId(s.fallbackProviderId);
      setVisionProviderId(s.visionProviderId);
      setNextCustomSeq(s.nextCustomSeq);
      const active = resolveActiveProvider(s.llmProviders, s.activeProviderId);
      setEditBuffer(editBufferFromProvider(active));
      const key = await providerKeys.getKey(active.id);
      setKeyConfigured(key.length > 0);
    })();
  }, []);

  if (providers === null) return null;
  // Narrowed local binding — the async handlers below are separate closures
  // that TS can't carry the `providers === null` narrowing into (the state
  // setter could theoretically run before they do), so they close over this
  // non-null snapshot instead of the raw `providers` state variable.
  const providerList: LlmProvider[] = providers;

  const active = resolveActiveProvider(providerList, activeProviderId);
  const fallbackProvider = fallbackProviderId
    ? providerList.find((p) => p.id === fallbackProviderId) ?? null
    : null;
  const visionProvider = visionProviderId
    ? providerList.find((p) => p.id === visionProviderId) ?? null
    : null;

  /** Read-modify-write of ONLY the LLM identity fields, against a FRESH
   * settings snapshot — mirrors persistNotificationHint's pattern
   * (settingsPersistence.ts) via savePersistedOnly, so a concurrent edit to
   * an unrelated field (e.g. the user typing in the capture-folder box)
   * can't be clobbered by this section's writes, and vice versa. Never
   * touches SecureStore — key writes go through providerKeys.ts on their
   * own, separately. */
  async function persistIdentity(
    patch: Partial<
      Pick<
        Settings,
        | "llmProviders"
        | "activeProviderId"
        | "nextCustomSeq"
        | "fallbackProviderId"
        | "visionProviderId"
      >
    >,
  ): Promise<void> {
    const current = await getSettings();
    await savePersistedOnly({ ...current, ...patch });
  }

  async function loadEntryForEditing(provider: LlmProvider): Promise<void> {
    setEditBuffer(editBufferFromProvider(provider));
    setPendingKey("");
    setConnectionResult(null);
    const key = await providerKeys.getKey(provider.id);
    setKeyConfigured(key.length > 0);
  }

  async function selectActive(id: string): Promise<void> {
    setPickerMode(null);
    try {
      await persistIdentity({ activeProviderId: id });
      setActiveProviderId(id);
      await loadEntryForEditing(resolveActiveProvider(providerList, id));
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to switch provider"));
    }
  }

  async function selectFallback(id: string | null): Promise<void> {
    setPickerMode(null);
    try {
      await persistIdentity({ fallbackProviderId: id });
      setFallbackProviderId(id);
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to set fallback provider"));
    }
  }

  async function selectVision(id: string | null): Promise<void> {
    setPickerMode(null);
    try {
      await persistIdentity({ visionProviderId: id });
      setVisionProviderId(id);
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to set vision provider"));
    }
  }

  async function saveEntry(): Promise<void> {
    try {
      const nextProviders = applyEditBuffer(providerList, active.id, editBuffer);
      await persistIdentity({ llmProviders: nextProviders });
      setProviders(nextProviders);
      if (pendingKey.length > 0) {
        await providerKeys.setKey(active.id, pendingKey);
        setKeyConfigured(true);
        setPendingKey("");
      }
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to save provider"));
    }
  }

  async function clearActiveKey(): Promise<void> {
    try {
      await providerKeys.deleteKey(active.id);
      setKeyConfigured(false);
      setPendingKey("");
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to clear the key"));
    }
  }

  async function addCustom(): Promise<void> {
    const errors = validateProvider({
      id: "",
      label: addLabel,
      baseUrl: addBaseUrl,
      model: "",
      visionModel: "",
      preset: null,
    });
    if (errors.length > 0) {
      onError(errors.join("; "));
      return;
    }
    try {
      const result = addCustomProvider(providerList, nextCustomSeq, {
        label: addLabel.trim(),
        baseUrl: addBaseUrl.trim(),
        model: "",
        visionModel: "",
      });
      await persistIdentity({
        llmProviders: result.providers,
        nextCustomSeq: result.nextCustomSeq,
      });
      setProviders(result.providers);
      setNextCustomSeq(result.nextCustomSeq);
      setAddOpen(false);
      setAddLabel("");
      setAddBaseUrl("");
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to add provider"));
    }
  }

  async function performDelete(id: string): Promise<void> {
    try {
      // Non-negotiable: removeProviderAndKey, never removeProvider — the
      // latter leaves the SecureStore key behind under an id that can be
      // reissued to a different endpoint (see providerKeys.ts's docstring).
      const nextProviders = await providerKeys.removeProviderAndKey(providerList, id);
      const identity = reassignIdentityAfterDelete(
        { activeProviderId, fallbackProviderId, visionProviderId },
        id,
      );
      // One write for the list AND all three identity ids together — a
      // dangling id must never be observable, even transiently.
      await persistIdentity({
        llmProviders: nextProviders,
        activeProviderId: identity.activeProviderId,
        fallbackProviderId: identity.fallbackProviderId,
        visionProviderId: identity.visionProviderId,
      });
      setProviders(nextProviders);
      setFallbackProviderId(identity.fallbackProviderId);
      setVisionProviderId(identity.visionProviderId);
      setActiveProviderId(identity.activeProviderId);
      if (identity.activeProviderId !== activeProviderId) {
        await loadEntryForEditing(
          resolveActiveProvider(nextProviders, identity.activeProviderId),
        );
      }
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to delete provider"));
    } finally {
      setDeleteTarget(null);
    }
  }

  async function testConnection(): Promise<void> {
    setTestingConnection(true);
    setConnectionResult(null);
    setConnectionResult(await healthCheck(editBuffer.baseUrl));
    setTestingConnection(false);
  }

  async function openBrowse(target: "chat" | "vision"): Promise<void> {
    setBrowseTarget(target);
    setBrowseError(null);
    setBrowseOpen(true);
    setModelFilter("");
    setBrowseLoading(true);
    try {
      const stored = await providerKeys.getKey(active.id);
      const key = resolveBrowseApiKey(pendingKey, stored);
      const list = await listModels(editBuffer.baseUrl, key);
      setModels(list);
    } catch (e: unknown) {
      setBrowseError(e instanceof Error ? e.message : String(e));
      setModels(null);
    } finally {
      setBrowseLoading(false);
    }
  }

  function pickModel(id: string): void {
    setEditBuffer(applyPickedModelToBuffer(editBuffer, browseTarget, id));
    setBrowseOpen(false);
  }

  const isRelais = active.id === "relais";
  const isCustom = active.preset === null;

  const pickerTitle =
    pickerMode === "fallback"
      ? "Offline fallback provider"
      : pickerMode === "vision"
        ? "Vision provider"
        : "Choose LLM provider";
  const pickerSelectedId =
    pickerMode === "fallback"
      ? fallbackProviderId
      : pickerMode === "vision"
        ? visionProviderId
        : activeProviderId;
  const handlePickerSelect = (id: string | null) => {
    if (pickerMode === "fallback") {
      void selectFallback(id);
    } else if (pickerMode === "vision") {
      void selectVision(id);
    } else if (id !== null) {
      void selectActive(id);
    }
  };

  const deleteTargetLabel = deleteTarget
    ? providerList.find((p) => p.id === deleteTarget)?.label ?? deleteTarget
    : "";

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={styles.title}>
        LLM provider
      </Text>
      <HelperText type="info" visible>
        Where AI enrichment runs. Presets are ready-made endpoints; add a
        custom entry for anything else OpenAI-compatible (Ollama, LM Studio,
        …).
      </HelperText>

      <List.Item
        title={active.label}
        description="Active provider — tap to change"
        left={(p) => <List.Icon {...p} icon="server-network" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("active")}
        style={styles.row}
      />

      {isCustom && (
        <TextInput
          {...caretProps(theme)}
          label="Label"
          mode="outlined"
          value={editBuffer.label}
          onChangeText={(v) => setEditBuffer({ ...editBuffer, label: v })}
        />
      )}

      <TextInput
        {...caretProps(theme)}
        label="Base URL"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={editBuffer.baseUrl}
        onChangeText={(v) => setEditBuffer({ ...editBuffer, baseUrl: v })}
        placeholder={isRelais ? "http://127.0.0.1:8080" : "https://..."}
      />
      <HelperText type="info" visible>
        Only 127.0.0.1 may use plain http:// — a provider on another machine
        must serve https://, because Android blocks plaintext to anything but
        loopback.
      </HelperText>

      <TextInput
        {...caretProps(theme)}
        label={apiKeyFieldLabel("API key", keyConfigured, pendingKey.length)}
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder={apiKeyFieldPlaceholder(
          keyConfigured,
          isRelais ? "optional — leave blank for an unauthenticated loopback server" : "sk-...",
        )}
        value={pendingKey}
        onChangeText={setPendingKey}
      />
      <HelperText type="info" visible>
        Stored in the secure keychain. The existing key is never shown again.
      </HelperText>
      {keyConfigured && (
        <Button mode="text" compact onPress={() => void clearActiveKey()} style={styles.inlineBtn}>
          Clear key
        </Button>
      )}

      <TextInput
        {...caretProps(theme)}
        label="Model"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={editBuffer.model}
        onChangeText={(v) => setEditBuffer({ ...editBuffer, model: v })}
        placeholder="e.g. gpt-4o-mini"
      />
      <Button
        mode="text"
        icon="format-list-bulleted"
        compact
        onPress={() => void openBrowse("chat")}
        disabled={!editBuffer.baseUrl.trim()}
        style={styles.inlineBtn}
      >
        Browse available models
      </Button>

      {isRelais ? (
        <HelperText type="info" visible>
          One model handles text, vision, and business-card OCR for this
          provider — no separate vision-model field.
        </HelperText>
      ) : (
        <>
          <TextInput
            {...caretProps(theme)}
            label="Vision model"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            value={editBuffer.visionModel}
            onChangeText={(v) => setEditBuffer({ ...editBuffer, visionModel: v })}
            placeholder="e.g. gpt-4o-mini (vision-capable)"
          />
          <HelperText type="info" visible>
            Used when you share a photo or image into carnet. Leave blank if
            this provider serves no vision-capable model.
          </HelperText>
          <Button
            mode="text"
            icon="format-list-bulleted"
            compact
            onPress={() => void openBrowse("vision")}
            disabled={!editBuffer.baseUrl.trim()}
            style={styles.inlineBtn}
          >
            Browse available models
          </Button>
        </>
      )}

      <Button mode="contained-tonal" onPress={() => void saveEntry()} style={styles.saveEntry}>
        Save provider
      </Button>

      <Button
        mode="text"
        icon="lan-connect"
        compact
        onPress={() => void testConnection()}
        loading={testingConnection}
        disabled={testingConnection}
        style={styles.inlineBtn}
      >
        Test connection
      </Button>
      {connectionResult === "ok" && (
        <HelperText type="info" visible>
          ✓ Reachable
        </HelperText>
      )}
      {connectionResult === "unreachable" && (
        <HelperText type="error" visible>
          Unreachable — check the URL and that the server is running.
        </HelperText>
      )}
      {connectionResult === "blocked-cleartext" && (
        <HelperText type="error" visible>
          Android blocked this plain http:// connection. Only 127.0.0.1 may
          use http:// — a provider on another machine needs https://.
        </HelperText>
      )}
      {connectionResult === "unsafe-url" && (
        <HelperText type="error" visible>
          Not a valid local address. Use http:// with 127.0.0.1, or https://
          for anything else.
        </HelperText>
      )}

      {isCustom && (
        <Button
          mode="text"
          compact
          textColor={theme.colors.error}
          onPress={() => setDeleteTarget(active.id)}
          style={styles.inlineBtn}
        >
          Delete this provider
        </Button>
      )}

      <Button
        mode="text"
        icon="plus"
        compact
        onPress={() => setAddOpen(true)}
        style={styles.inlineBtn}
      >
        Add custom provider
      </Button>

      <Text variant="titleMedium" style={styles.subTitle}>
        Offline fallback
      </Text>
      <HelperText type="info" visible>
        Used once, automatically, when the active provider is unreachable —
        never when it rejects a bad key or model id.
      </HelperText>
      <List.Item
        title={fallbackProvider ? fallbackProvider.label : "None"}
        left={(p) => <List.Icon {...p} icon="cloud-off-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("fallback")}
        style={styles.row}
      />

      <Text variant="titleMedium" style={styles.subTitle}>
        Vision provider
      </Text>
      <HelperText type="info" visible>
        Used for photo/image captures when the active provider has no vision
        model of its own.
      </HelperText>
      <List.Item
        title={visionProvider ? visionProvider.label : "None"}
        left={(p) => <List.Icon {...p} icon="image-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("vision")}
        style={styles.row}
      />

      <ProviderPickerModal
        theme={theme}
        visible={pickerMode !== null}
        onDismiss={() => setPickerMode(null)}
        title={pickerTitle}
        providers={providerList}
        selectedId={pickerSelectedId}
        allowNone={pickerMode !== "active"}
        onSelect={handlePickerSelect}
        onDeleteCustom={(id) => {
          setPickerMode(null);
          setDeleteTarget(id);
        }}
      />

      <Portal>
        <Dialog visible={addOpen} onDismiss={() => setAddOpen(false)}>
          <Dialog.Title>Add custom provider</Dialog.Title>
          <Dialog.Content style={styles.dialogContent}>
            <TextInput
              {...caretProps(theme)}
              label="Label"
              mode="outlined"
              value={addLabel}
              onChangeText={setAddLabel}
              placeholder="e.g. My Ollama"
            />
            <TextInput
              {...caretProps(theme)}
              label="Base URL"
              mode="outlined"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={addBaseUrl}
              onChangeText={setAddBaseUrl}
              placeholder="e.g. https://192.168.1.50:11434"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAddOpen(false)}>Cancel</Button>
            <Button onPress={() => void addCustom()}>Add</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Portal>
        <Dialog visible={deleteTarget !== null} onDismiss={() => setDeleteTarget(null)}>
          <Dialog.Title>Delete provider?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              "{deleteTargetLabel}" and its stored API key will be removed.
              This can't be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              textColor={theme.colors.error}
              onPress={() => {
                if (deleteTarget) void performDelete(deleteTarget);
              }}
            >
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <ModelBrowserModal
        theme={theme}
        visible={browseOpen}
        onDismiss={() => setBrowseOpen(false)}
        loading={browseLoading}
        error={browseError}
        onRetry={() => void openBrowse(browseTarget)}
        filter={modelFilter}
        onFilterChange={setModelFilter}
        recommended={recommended}
        others={others}
        onPickModel={pickModel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  title: { paddingHorizontal: 0, paddingTop: spacing.sm },
  subTitle: { paddingHorizontal: 0, paddingTop: spacing.lg },
  row: { paddingHorizontal: 0 },
  inlineBtn: { alignSelf: "flex-start", marginTop: spacing.xs },
  saveEntry: { alignSelf: "flex-start", marginTop: spacing.sm },
  dialogContent: { gap: spacing.sm },
});
