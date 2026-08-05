import { StyleSheet } from "react-native";
import { Button, Dialog, Portal, TextInput } from "react-native-paper";

import { caretProps, spacing, type CarnetTheme } from "../lib/theme";

interface AddProviderDialogProps {
  theme: CarnetTheme;
  visible: boolean;
  label: string;
  baseUrl: string;
  onLabelChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onCancel: () => void;
  onAdd: () => void;
}

/**
 * "Add custom provider" form — label + base URL for any OpenAI-compatible
 * endpoint (Ollama, LM Studio, a self-hosted gateway).
 *
 * Model and API key are deliberately NOT collected here: the entry is created
 * first, then edited in place, so the key write is a separate step keyed to a
 * provider id that already exists (see providerKeys.ts).
 *
 * Extracted from LlmProviderSection.tsx to keep it under this repo's 800-line
 * ceiling; behaviour is unchanged. Validation still lives with the caller —
 * llmProviders.ts's validateProvider runs on add, and rejects a non-http(s)
 * scheme before anything is persisted.
 */
export function AddProviderDialog({
  theme,
  visible,
  label,
  baseUrl,
  onLabelChange,
  onBaseUrlChange,
  onCancel,
  onAdd,
}: AddProviderDialogProps) {
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onCancel}>
        <Dialog.Title>Add custom provider</Dialog.Title>
        <Dialog.Content style={styles.content}>
          <TextInput
            {...caretProps(theme)}
            label="Label"
            mode="outlined"
            value={label}
            onChangeText={onLabelChange}
            placeholder="e.g. My Ollama"
          />
          <TextInput
            {...caretProps(theme)}
            label="Base URL"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={baseUrl}
            onChangeText={onBaseUrlChange}
            placeholder="e.g. https://192.168.1.50:11434"
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onCancel}>Cancel</Button>
          <Button onPress={onAdd}>Add</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
});
