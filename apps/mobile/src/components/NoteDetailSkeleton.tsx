import { StyleSheet, View } from "react-native";

import type { CarnetTheme } from "../lib/theme";

interface NoteDetailSkeletonProps {
  theme: CarnetTheme;
}

/**
 * Loading state for the note detail screen: skeleton paragraph blocks that read
 * as "content coming", not a spinner. The first block is the title line.
 */
export function NoteDetailSkeleton({ theme }: NoteDetailSkeletonProps) {
  return (
    <View
      style={[
        styles.loading,
        {
          backgroundColor: theme.colors.background,
          padding: theme.carnet.spacing.lg,
          gap: theme.carnet.spacing.md,
        },
      ]}
    >
      {[64, 16, 16, 16].map((h, i) => (
        <View
          key={i}
          style={{
            height: h,
            width: i === 0 ? "60%" : "100%",
            backgroundColor: theme.colors.surfaceVariant,
            borderRadius: theme.carnet.radius.sm,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
});
