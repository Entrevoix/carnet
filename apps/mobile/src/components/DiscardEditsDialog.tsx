import { Button, Dialog, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface DiscardEditsDialogProps {
  theme: CarnetTheme;
  visible: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * Unsaved-changes prompt. Rendered from BOTH note-detail edit surfaces — the
 * full-screen rich editor and the scrolling markdown layout — which is why it
 * lives here rather than inline in either one.
 *
 * Callers wrap it in their own <Portal>; this component is just the dialog.
 */
export function DiscardEditsDialog({
  theme,
  visible,
  onKeepEditing,
  onDiscard,
}: DiscardEditsDialogProps) {
  return (
    <Dialog visible={visible} onDismiss={onKeepEditing}>
      <Dialog.Title>Discard changes?</Dialog.Title>
      <Dialog.Content>
        <Text variant="bodyMedium">
          You have unsaved edits. Discard them and leave?
        </Text>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onKeepEditing}>Keep editing</Button>
        <Button onPress={onDiscard} textColor={theme.colors.error}>
          Discard
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}
