import { StyleSheet } from "react-native";
import { Button, HelperText, List, Switch, TextInput } from "react-native-paper";

import type { HealthResult } from "../lib/llmClient";
import { shouldShowInsecureTransportToggle, type EditBuffer } from "../lib/llmProviderForm";
import { apiKeyFieldLabel, apiKeyFieldPlaceholder } from "../lib/settingsForm";
import { caretProps, spacing, type CarnetTheme } from "../lib/theme";

interface ProviderEditFormProps {
  theme: CarnetTheme;
  editBuffer: EditBuffer;
  onLabelChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onVisionModelChange: (v: string) => void;
  onAllowInsecureTransportChange: (v: boolean) => void;
  isCustom: boolean;
  isRelais: boolean;
  keyConfigured: boolean;
  pendingKey: string;
  onPendingKeyChange: (v: string) => void;
  onClearKey: () => void;
  onBrowseChatModels: () => void;
  onBrowseVisionModels: () => void;
  onSaveEntry: () => void;
  writing: boolean;
  testingConnection: boolean;
  canTestConnection: boolean;
  onTestConnection: () => void;
  connectionResult: HealthResult | null;
  onDeleteRequest: () => void;
  onAddOpen: () => void;
}

/**
 * The active provider's edit form: label/base URL/API key/model/vision model
 * fields, Save/Test connection/Delete buttons, and the "Add custom provider"
 * entry point.
 *
 * Extracted from LlmProviderSection.tsx to keep it under this repo's 800-line
 * ceiling; behaviour is unchanged. Pure presentation: the section keeps all
 * state, persistence, and picker wiring — every callback prop here is
 * already the exact handler (or `() => void handler()` wrapper) the section
 * used to pass to these same elements inline.
 */
export function ProviderEditForm({
  theme,
  editBuffer,
  onLabelChange,
  onBaseUrlChange,
  onModelChange,
  onVisionModelChange,
  onAllowInsecureTransportChange,
  isCustom,
  isRelais,
  keyConfigured,
  pendingKey,
  onPendingKeyChange,
  onClearKey,
  onBrowseChatModels,
  onBrowseVisionModels,
  onSaveEntry,
  writing,
  testingConnection,
  canTestConnection,
  onTestConnection,
  connectionResult,
  onDeleteRequest,
  onAddOpen,
}: ProviderEditFormProps) {
  return (
    <>
      {isCustom && (
        <TextInput
          {...caretProps(theme)}
          label="Label"
          mode="outlined"
          value={editBuffer.label}
          onChangeText={onLabelChange}
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
        onChangeText={onBaseUrlChange}
        placeholder={isRelais ? "http://127.0.0.1:8080" : "https://..."}
      />
      {/* History of this copy, because it has flip-flopped with evidence each
          time: it originally promised LAN http://, was then narrowed to
          loopback-only after a 2026-08-01 device check found Android refusing
          LAN cleartext on a release build, and a 2026-08-16 emulator
          investigation (#153) then found even LOOPBACK refused on API 35 —
          the platform default was version-dependent all along. Since
          withCleartextLocalProviders.js pins usesCleartextTraffic, the app's
          own allowlist (netAllowlist.ts: loopback + RFC1918) is the single
          gate on every Android version, and this copy states that. Keep the
          three in sync: this text, netAllowlist.ts, and the plugin. */}
      <HelperText type="info" visible>
        Local addresses (127.0.0.1 or a private 10.x / 172.16–31.x / 192.168.x
        host, e.g. Relais or Ollama on your LAN) may use plain http://. Any
        other provider must serve https:// so your API key is never sent in
        the clear.
      </HelperText>

      {shouldShowInsecureTransportToggle(editBuffer.baseUrl) && (
        <>
          {/* #176: this address is plain http:// and NOT one of the
              loopback/RFC1918 hosts the transport gate already allows
              (netAllowlist.ts) — e.g. a Tailscale/VPN hostname. Off by
              default; consenting here sets LlmProvider.allowInsecureTransport
              for THIS entry only, and the consent is stripped on settings
              import (see settingsTransfer.ts) so a receiving device must
              re-consent explicitly. */}
          <List.Item
            title="Send unencrypted to this address"
            description="This address looks like a private network (VPN/LAN). Send the API key and note text unencrypted to it?"
            descriptionNumberOfLines={3}
            left={(p) => <List.Icon {...p} icon="lock-open-alert-outline" />}
            right={() => (
              <Switch
                value={editBuffer.allowInsecureTransport}
                onValueChange={onAllowInsecureTransportChange}
              />
            )}
            style={styles.insecureTransportRow}
          />
          <HelperText type="error" visible={editBuffer.allowInsecureTransport}>
            Both your API key and the note's full text will cross this
            connection unencrypted. Only enable this for a network you trust.
          </HelperText>
        </>
      )}

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
        onChangeText={onPendingKeyChange}
      />
      <HelperText type="info" visible>
        Stored in the secure keychain. The existing key is never shown again.
      </HelperText>
      {keyConfigured && (
        <Button mode="text" compact onPress={onClearKey} style={styles.inlineBtn}>
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
        onChangeText={onModelChange}
        placeholder="e.g. gpt-4o-mini"
      />
      <Button
        mode="text"
        icon="format-list-bulleted"
        compact
        onPress={onBrowseChatModels}
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
            onChangeText={onVisionModelChange}
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
            onPress={onBrowseVisionModels}
            disabled={!editBuffer.baseUrl.trim()}
            style={styles.inlineBtn}
          >
            Browse available models
          </Button>
        </>
      )}

      <Button
        mode="contained-tonal"
        onPress={onSaveEntry}
        disabled={writing}
        style={styles.saveEntry}
      >
        Save provider
      </Button>

      <Button
        mode="text"
        icon="lan-connect"
        compact
        onPress={onTestConnection}
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
      {connectionResult === "unauthorized" && (
        <HelperText type="error" visible>
          The server answered but rejected the API key. The URL is fine — check
          the key.
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
      {connectionResult === "untrusted-tls" && (
        <HelperText type="error" visible>
          Server uses a certificate this device doesn't trust — see the
          provider's docs for a trusted setup. (Self-signed certificates
          aren't supported yet.)
        </HelperText>
      )}

      {isCustom && (
        <Button
          mode="text"
          compact
          textColor={theme.colors.error}
          onPress={onDeleteRequest}
          style={styles.inlineBtn}
        >
          Delete this provider
        </Button>
      )}

      <Button mode="text" icon="plus" compact onPress={onAddOpen} style={styles.inlineBtn}>
        Add custom provider
      </Button>
    </>
  );
}

// Copied verbatim from LlmProviderSection's stylesheet so the extraction is a
// pure refactor — these fields/buttons must render byte-identically to before.
const styles = StyleSheet.create({
  inlineBtn: { alignSelf: "flex-start", marginTop: spacing.xs },
  saveEntry: { alignSelf: "flex-start", marginTop: spacing.sm },
  insecureTransportRow: { paddingHorizontal: 0 },
});
