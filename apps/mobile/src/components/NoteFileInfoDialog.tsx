import { StyleSheet } from "react-native";
import { Button, Dialog, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface NoteFileInfoDialogProps {
  theme: CarnetTheme;
  visible: boolean;
  onDismiss: () => void;
  /** Absolute vault path — selectable so it can be copied out. */
  filepath: string;
  /** Already-formatted "<Mode> · captured <date>" line. */
  summary: string;
}

/**
 * "Where this note lives in the vault". The raw path is deliberately kept off
 * the reading surface and shown only here, on request.
 *
 * Callers wrap this in their own <Portal>.
 */
export function NoteFileInfoDialog({
  theme,
  visible,
  onDismiss,
  filepath,
  summary,
}: NoteFileInfoDialogProps) {
  return (
    <Dialog
      visible={visible}
      onDismiss={onDismiss}
      style={{ borderRadius: theme.carnet.radius.sheet }}
    >
      <Dialog.Title>File info</Dialog.Title>
      <Dialog.Content style={{ gap: theme.carnet.spacing.sm }}>
        <Text variant="bodySmall" selectable style={styles.path}>
          {filepath}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {summary}
        </Text>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onDismiss}>Close</Button>
      </Dialog.Actions>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  path: { opacity: 0.6, fontFamily: "monospace" },
});
