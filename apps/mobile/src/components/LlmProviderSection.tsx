import { useEffect, useMemo, useRef, useState } from "react";
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

import { getSettings } from "../lib/settings";
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
import { useProviderWriteChain } from "../lib/useProviderWriteChain";
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
 *
 * All writes to `llmProviders`/the identity ids funnel through
 * `useProviderWriteChain`'s `persistIdentity` (../lib/useProviderWriteChain.ts),
 * which serializes them on a single-flight promise chain instead of each
 * handler doing its own independent read-modify-write — see that module's
 * header for the lost-update bug this prevents. `writing` (also from that
 * hook) disables Save and the picker rows while a write is in flight.
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

  const { persistIdentity, writing } = useProviderWriteChain();
  /** Invalidates an in-flight health check when the edited entry changes
   * (switching active, or after a delete reassigns it) — see testConnection
   * and loadEntryForEditing. */
  const connectionRequestRef = useRef(0);
  /** Guards every setState that follows an `await` in this component's
   * handlers against firing after unmount (navigating away from Settings
   * mid-write). */
  const mountedRef = useRef(true);

  // useMemo MUST run on every render in the same order — above the
  // `if (providers === null) return null` below (mirrors SettingsScreen's
  // own top-level useMemo for the same reason).
  const { recommended, others } = useMemo(
    () => filterAndSplitModels(models, modelFilter, RECOMMENDED_MODELS),
    [models, modelFilter],
  );

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const s = await getSettings();
      if (!mountedRef.current) return;
      setProviders(s.llmProviders);
      setActiveProviderId(s.activeProviderId);
      setFallbackProviderId(s.fallbackProviderId);
      setVisionProviderId(s.visionProviderId);
      setNextCustomSeq(s.nextCustomSeq);
      const active = resolveActiveProvider(s.llmProviders, s.activeProviderId);
      setEditBuffer(editBufferFromProvider(active));
      const key = await providerKeys.getKey(active.id);
      if (!mountedRef.current) return;
      setKeyConfigured(key.length > 0);
    })();
    return () => {
      mountedRef.current = false;
    };
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

  async function loadEntryForEditing(provider: LlmProvider): Promise<void> {
    connectionRequestRef.current += 1; // invalidate any in-flight health check
    setEditBuffer(editBufferFromProvider(provider));
    setPendingKey("");
    setConnectionResult(null);
    const key = await providerKeys.getKey(provider.id);
    if (!mountedRef.current) return;
    setKeyConfigured(key.length > 0);
  }

  async function selectActive(id: string): Promise<void> {
    setPickerMode(null);
    try {
      await persistIdentity({ activeProviderId: id });
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
      setFallbackProviderId(id);
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to set fallback provider"));
    }
  }

  async function selectVision(id: string | null): Promise<void> {
    setPickerMode(null);
    try {
      await persistIdentity({ visionProviderId: id });
      if (!mountedRef.current) return;
      setVisionProviderId(id);
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to set vision provider"));
    }
  }

  async function saveEntry(): Promise<void> {
    // Gates the SAME check addCustom already applied on the add path —
    // this path (editing any existing entry, including a preset) used to
    // call nothing, so e.g. a `javascript:alert(1)` base URL would persist
    // untouched and only fail much later, at enrichment time, with an
    // unrelated error.
    const errors = validateProvider({
      id: active.id,
      label: editBuffer.label,
      baseUrl: editBuffer.baseUrl,
      model: editBuffer.model,
      visionModel: editBuffer.visionModel,
      preset: active.preset,
    });
    if (errors.length > 0) {
      onError(errors.join("; "));
      return;
    }
    // `active`/`editBuffer`/`pendingKey` are THIS render's values — a plain
    // JS closure, not a ref, so they stay fixed for the life of this async
    // call regardless of what the user does in the UI while it's in
    // flight. Named locally only so the intent ("this is the entry Save was
    // tapped for") is explicit at each use below.
    const targetId = active.id;
    const buffer = editBuffer;
    const keyToWrite = pendingKey;
    try {
      const nextProviders = applyEditBuffer(providerList, targetId, buffer);
      await persistIdentity({ llmProviders: nextProviders });
      if (!mountedRef.current) return;
      setProviders(nextProviders);
      if (keyToWrite.length > 0) {
        await providerKeys.setKey(targetId, keyToWrite);
        if (!mountedRef.current) return;
        setKeyConfigured(true);
        // Only clear the pending-key field if it still holds the value we
        // just wrote — the user may have already switched to a different
        // entry (which itself clears pendingKey via loadEntryForEditing) or
        // started typing a new key while this write was in flight.
        setPendingKey((current) => (current === keyToWrite ? "" : current));
      }
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to save provider"));
    }
  }

  async function clearActiveKey(): Promise<void> {
    // `active.id` is this render's closed-over value — see saveEntry's
    // comment above for why that's exactly the entry Clear key was tapped
    // for, regardless of what the user does in the UI while this awaits.
    const targetId = active.id;
    try {
      await providerKeys.deleteKey(targetId);
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
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
    let nextProviders: LlmProvider[];
    try {
      // Non-negotiable: removeProviderAndKey, never removeProvider — the
      // latter leaves the SecureStore key behind under an id that can be
      // reissued to a different endpoint (see providerKeys.ts's docstring).
      // providerKeys.ts checks preset-illegality BEFORE deleting anything,
      // so a rejection here means NOTHING changed yet.
      nextProviders = await providerKeys.removeProviderAndKey(providerList, id);
    } catch (e: unknown) {
      onError(errorMessage(e, "Failed to delete provider"));
      setDeleteTarget(null);
      return;
    }
    if (!mountedRef.current) return;

    // From this point on the key is IRREVERSIBLY gone from SecureStore even
    // if the settings write below fails — the confirm dialog promised both
    // are removed, and the key half of that already happened, so the UI
    // must reflect the entry as gone too rather than show a "configured"
    // provider whose credential silently no longer works.
    const identity = reassignIdentityAfterDelete(
      { activeProviderId, fallbackProviderId, visionProviderId },
      id,
    );
    setProviders(nextProviders);
    setFallbackProviderId(identity.fallbackProviderId);
    setVisionProviderId(identity.visionProviderId);
    setActiveProviderId(identity.activeProviderId);
    if (identity.activeProviderId !== activeProviderId) {
      await loadEntryForEditing(
        resolveActiveProvider(nextProviders, identity.activeProviderId),
      );
      if (!mountedRef.current) return;
    }

    try {
      // One write for the list AND all three identity ids together — a
      // dangling id must never be observable, even transiently.
      await persistIdentity({
        llmProviders: nextProviders,
        activeProviderId: identity.activeProviderId,
        fallbackProviderId: identity.fallbackProviderId,
        visionProviderId: identity.visionProviderId,
      });
    } catch (e: unknown) {
      onError(
        errorMessage(
          e,
          "Deleted the provider and its key, but saving the change failed — it may reappear until you restart the app",
        ),
      );
    } finally {
      setDeleteTarget(null);
    }
  }

  async function testConnection(): Promise<void> {
    const requestId = ++connectionRequestRef.current;
    setTestingConnection(true);
    setConnectionResult(null);
    const result = await healthCheck(editBuffer.baseUrl);
    if (!mountedRef.current) return;
    setTestingConnection(false);
    // Stale-result guard: if the edited entry changed (switch, or a delete
    // reassigning the active entry) while this check was in flight,
    // connectionRequestRef no longer matches — discard the result rather
    // than render a health check for one provider under a different one's
    // header.
    if (connectionRequestRef.current === requestId) {
      setConnectionResult(result);
    }
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
      if (!mountedRef.current) return;
      setModels(list);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      setBrowseError(e instanceof Error ? e.message : String(e));
      setModels(null);
    } finally {
      if (mountedRef.current) setBrowseLoading(false);
    }
  }

  function pickModel(id: string): void {
    setEditBuffer(applyPickedModelToBuffer(editBuffer, browseTarget, id));
    setBrowseOpen(false);
  }

  const isRelais = active.id === "relais";
  const isCustom = active.preset === null;
  // Only relais has a meaningful "blank means loopback" default
  // (llmClient.ts's DEFAULT_LOCAL_LLM_URL) — for every other provider a
  // blank base URL silently probing 127.0.0.1:8080 and reporting "✓
  // Reachable" would be actively misleading (reproduced against OmniRoute
  // with no URL configured yet), so Test connection is disabled instead.
  const canTestConnection = editBuffer.baseUrl.trim().length > 0 || isRelais;

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
        accessibilityLabel="Choose active LLM provider"
        left={(p) => <List.Icon {...p} icon="server-network" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("active")}
        disabled={writing}
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
      {/* This copy previously claimed LAN addresses could use plain http://.
          They cannot: Android permits cleartext to loopback but refuses it to
          any other address on a release build (device-verified 2026-08-01), so
          users following that advice hit a bare "Unreachable" with a server
          that was running perfectly. Do not reintroduce that claim. */}
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

      <Button
        mode="contained-tonal"
        onPress={() => void saveEntry()}
        disabled={writing}
        style={styles.saveEntry}
      >
        Save provider
      </Button>

      <Button
        mode="text"
        icon="lan-connect"
        compact
        onPress={() => void testConnection()}
        loading={testingConnection}
        disabled={testingConnection || !canTestConnection}
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
        accessibilityLabel="Choose offline fallback provider"
        left={(p) => <List.Icon {...p} icon="cloud-off-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("fallback")}
        disabled={writing}
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
        accessibilityLabel="Choose vision provider"
        left={(p) => <List.Icon {...p} icon="image-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={() => setPickerMode("vision")}
        disabled={writing}
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
