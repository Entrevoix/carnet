import { StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";

import { useCarnetTheme } from "../lib/theme";

export type StampTone = "accent" | "stamp" | "neutral";

interface StampChipProps {
  label: string;
  /** Material Community icon name rendered before the label. */
  icon?: string;
  /** "accent" (default) = teal tag/badge; "stamp" = destructive/attention
   * red; "neutral" = quiet gray for inactive filter pills. */
  tone?: StampTone;
}

/**
 * The design system's one recurring motif: a dashed-border pill, tinted and
 * tilted −1° like a rubber stamp. Used for note tags, sync-status badges, and
 * category/mode labels — and for nothing else decorative (see DESIGN.md).
 * Display-only; wrap in a touchable at the call site when a stamp needs to act.
 */
export function StampChip({ label, icon, tone = "accent" }: StampChipProps) {
  const theme = useCarnetTheme();
  const border =
    tone === "stamp"
      ? theme.carnet.stamp
      : tone === "neutral"
        ? theme.colors.outline
        : theme.colors.primary;
  const background =
    tone === "stamp"
      ? theme.colors.errorContainer
      : tone === "neutral"
        ? theme.colors.surfaceVariant
        : theme.colors.primaryContainer;
  const foreground =
    tone === "stamp"
      ? theme.colors.onErrorContainer
      : tone === "neutral"
        ? theme.colors.onSurfaceVariant
        : theme.colors.onPrimaryContainer;

  return (
    <View
      style={[
        styles.pill,
        {
          borderColor: border,
          backgroundColor: background,
          borderRadius: theme.carnet.radius.pill,
          paddingHorizontal: theme.carnet.spacing.sm,
          paddingVertical: theme.carnet.spacing.xs / 2,
        },
      ]}
    >
      {icon ? <Icon source={icon} size={12} color={foreground} /> : null}
      <Text
        variant="labelSmall"
        style={{ color: foreground }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderStyle: "dashed",
    alignSelf: "flex-start",
    // The stamp tilt. If a device renders dashed+rotated borders with
    // artifacts, drop borderStyle to solid and keep the rotation (DESIGN.md).
    transform: [{ rotate: "-1deg" }],
  },
});
