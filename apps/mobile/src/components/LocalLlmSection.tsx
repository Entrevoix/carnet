import { StyleSheet, View } from "react-native";
import { Button, HelperText, Text, TextInput } from "react-native-paper";

import {
  apiKeyFieldLabel,
  apiKeyFieldPlaceholder,
} from "../lib/settingsForm";
import { caretProps, type CarnetTheme } from "../lib/theme";

interface LocalLlmSectionProps {
  theme: CarnetTheme;
  url: string;
  onUrlChange: (next: string) => void;
  keyConfigured: boolean;
  /** A NEW key the user is entering. Empty string means "no change". */
  pendingKey: string;
  onPendingKeyChange: (next: string) => void;
  onClearKey: () => void;
  model: string;
  onModelChange: (next: string) => void;
  testingConnection: boolean;
  connectionResult: "ok" | "unreachable" | null;
  onTestConnection: () => void;
}

/**
 * Settings → Local LLM config, shown when `llmBackend === "local"`. A
 * loopback or LAN OpenAI-compatible server (e.g. Relais) — text, vision, and
 * business-card OCR all go through the one model field, unlike OmniRoute's
 * separate chat/vision models. Purely presentational: all form state and the
 * healthCheck-backed connection test live in SettingsScreen; this component
 * only renders the given values and reports edits/actions back up.
 */
export function LocalLlmSection({
  theme,
  url,
  onUrlChange,
  keyConfigured,
  pendingKey,
  onPendingKeyChange,
  onClearKey,
  model,
  onModelChange,
  testingConnection,
  connectionResult,
  onTestConnection,
}: LocalLlmSectionProps) {
  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={styles.subsectionTitle}>
        Local LLM
      </Text>
      <HelperText type="info" visible>
        A loopback or LAN OpenAI-compatible server (e.g. Relais). Blank
        URL defaults to http://127.0.0.1:8080 — no setup needed if Relais
        is already running on this device.
      </HelperText>
      <TextInput
        {...caretProps(theme)}
        label="Local LLM URL"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={onUrlChange}
        placeholder="http://127.0.0.1:8080"
      />
      <HelperText type="info" visible>
        Local LLM base URL — loopback (127.0.0.1) or LAN addresses are
        allowed over plain http://; anything else must use https://.
      </HelperText>

      <TextInput
        {...caretProps(theme)}
        label={apiKeyFieldLabel(
          "Local LLM API key",
          keyConfigured,
          pendingKey.length,
        )}
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder={apiKeyFieldPlaceholder(
          keyConfigured,
          "optional — leave blank for an unauthenticated loopback server",
        )}
        value={pendingKey}
        onChangeText={onPendingKeyChange}
      />
      <HelperText type="info" visible>
        Stored in the secure keychain. The existing key is never shown
        again. Most loopback deployments (e.g. Relais on this device)
        need no key at all.
      </HelperText>
      {keyConfigured && (
        <Button mode="text" compact onPress={onClearKey} style={styles.clearKey}>
          Clear key
        </Button>
      )}

      <TextInput
        {...caretProps(theme)}
        label="Model"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={model}
        onChangeText={onModelChange}
        placeholder="e.g. litert-community/gemma-4-E4B-it-litert-lm"
      />
      <HelperText type="info" visible>
        One model handles text, vision, and business-card OCR for the
        local backend — no separate vision-model field.
      </HelperText>

      <Button
        mode="text"
        icon="lan-connect"
        compact
        onPress={onTestConnection}
        loading={testingConnection}
        disabled={testingConnection}
        style={styles.testBtn}
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
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 16 },
  // Named `subsectionTitle` (not `sectionTitle`) — SettingsScreen's own
  // `styles.sectionTitle` uses paddingTop: 16, not 8. Same-named keys with
  // different values across files is a copy-paste trap; keep them distinct.
  subsectionTitle: { paddingHorizontal: 0, paddingTop: 8 },
  clearKey: { alignSelf: "flex-start", marginTop: 4 },
  testBtn: { alignSelf: "flex-start", marginTop: 4 },
});
