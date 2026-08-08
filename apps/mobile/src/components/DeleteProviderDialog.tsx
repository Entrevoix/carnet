import { Button, Dialog, Portal, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface DeleteProviderDialogProps {
  theme: CarnetTheme;
  /** Display label of the entry queued for deletion; null = dialog hidden. */
  targetLabel: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation for deleting a custom LLM provider entry.
 *
 * Destructive and irreversible in a way worth spelling out: the entry's API key
 * is removed from SecureStore alongside it, and the freed id is never reissued
 * (see llmProviders.ts's addCustomProvider — reuse would point an old stored
 * key at a new endpoint).
 *
 * Extracted from LlmProviderSection.tsx purely to keep that file under this
 * repo's 800-line ceiling; behaviour is unchanged.
 */
export function DeleteProviderDialog({
  theme,
  targetLabel,
  onCancel,
  onConfirm,
}: DeleteProviderDialogProps) {
  return (
    <Portal>
      <Dialog visible={targetLabel !== null} onDismiss={onCancel}>
        <Dialog.Title>Delete provider?</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium">
            "{targetLabel}" and its stored API key will be removed. This can't be
            undone.
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onCancel}>Cancel</Button>
          <Button textColor={theme.colors.error} onPress={onConfirm}>
            Delete
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
