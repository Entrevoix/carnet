import { StyleSheet, View } from "react-native";
import { Button, IconButton, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface NoteMissingStateProps {
  theme: CarnetTheme;
  onRemoveFromList: () => void;
}

/**
 * Shown when the .md can't be read — almost always because the user renamed or
 * deleted it in Obsidian after carnet captured it. Takes over the whole screen
 * (nothing else renders over it) and offers the one safe action: drop the
 * dangling history row.
 */
export function NoteMissingState({ theme, onRemoveFromList }: NoteMissingStateProps) {
  return (
    <View style={[styles.missingWrap, { gap: theme.carnet.spacing.md }]}>
      <IconButton icon="file-question-outline" size={48} />
      <Text variant="titleMedium">Note not found</Text>
      <Text
        variant="bodyMedium"
        style={[styles.missingText, { color: theme.colors.onSurfaceVariant }]}
      >
        This note was moved or deleted outside carnet — probably in Obsidian. Its
        history entry can be removed safely.
      </Text>
      <Button mode="contained-tonal" onPress={onRemoveFromList}>
        Remove from list
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  missingWrap: { alignItems: "center", paddingVertical: 48 },
  missingText: { textAlign: "center" },
});
