import { Button, Dialog, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface ArchiveNoteDialogProps {
  theme: CarnetTheme;
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Soft-delete confirmation. Deleting a note moves it (and any paired binary)
 * to Archive/ rather than unlinking it, so the copy names the recovery path.
 *
 * Callers wrap this in their own <Portal>.
 */
export function ArchiveNoteDialog({
  theme,
  visible,
  onCancel,
  onConfirm,
}: ArchiveNoteDialogProps) {
  return (
    <Dialog visible={visible} onDismiss={onCancel}>
      <Dialog.Title>Move to Archive?</Dialog.Title>
      <Dialog.Content>
        <Text variant="bodyMedium">
          The note and any paired file will be moved to Archive/. You can recover
          them by browsing the vault in Obsidian.
        </Text>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onCancel}>Cancel</Button>
        <Button onPress={onConfirm} textColor={theme.colors.error}>
          Delete
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}
