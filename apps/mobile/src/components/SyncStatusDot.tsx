import { StyleSheet, View } from "react-native";
import { IconButton } from "react-native-paper";

import type { SyncStatus } from "../lib/syncStatus";
import { useCarnetTheme } from "../lib/theme";

interface SyncStatusDotProps {
  status: SyncStatus;
  onPress: () => void;
}

/**
 * The quiet, always-present sync indicator (header, next to the title): a
 * small dot — teal when idle, teal-on-soft when the enrichment queue is
 * working, stamp-red when something failed permanently. Tap-through opens
 * the owner's detail dialog. Icon+color only; no text in the header.
 */
export function SyncStatusDot({ status, onPress }: SyncStatusDotProps) {
  const theme = useCarnetTheme();
  const color =
    status.state === "error"
      ? theme.carnet.stamp
      : status.state === "pending"
        ? theme.colors.primary
        : theme.colors.onSurfaceVariant;
  const icon =
    status.state === "error"
      ? "alert-circle"
      : status.state === "pending"
        ? "sync"
        : "check-circle-outline";

  return (
    <View style={styles.wrap}>
      <IconButton
        icon={icon}
        iconColor={color}
        size={18}
        onPress={onPress}
        accessibilityLabel={`Sync status: ${status.state}. ${status.detail}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Keep the touch target ≥48dp while the glyph stays small and quiet.
  wrap: { justifyContent: "center" },
});
