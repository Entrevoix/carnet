import { StyleSheet } from "react-native";
import { HelperText, List, Text } from "react-native-paper";

import { spacing } from "../lib/theme";

interface ProviderRoleRowProps {
  /** Section heading, e.g. "Vision provider". */
  title: string;
  /** One-line explanation of when this role's provider is consulted. */
  helper: string;
  /** Resolved provider label, or null to show "None". */
  providerLabel: string | null;
  icon: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}

/**
 * One "role → provider" row in the LLM provider section: a subheading, a line
 * of help, and a tappable row that opens the provider picker.
 *
 * Extracted because the fallback / vision / enhance rows are structurally
 * identical and LlmProviderSection.tsx was within ~20 lines of this repo's
 * 800-line ceiling — adding a fourth copy inline would have pushed it over.
 * Pure presentation: the section keeps all state, persistence, and picker
 * wiring.
 */
export function ProviderRoleRow({
  title,
  helper,
  providerLabel,
  icon,
  accessibilityLabel,
  disabled,
  onPress,
}: ProviderRoleRowProps) {
  return (
    <>
      <Text variant="titleMedium" style={styles.subTitle}>
        {title}
      </Text>
      <HelperText type="info" visible>
        {helper}
      </HelperText>
      <List.Item
        title={providerLabel ?? "None"}
        accessibilityLabel={accessibilityLabel}
        left={(p) => <List.Icon {...p} icon={icon} />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={onPress}
        disabled={disabled}
        style={styles.row}
      />
    </>
  );
}

// Copied verbatim from LlmProviderSection's stylesheet so the extraction is a
// pure refactor — these rows must render byte-identically to before.
const styles = StyleSheet.create({
  subTitle: { paddingHorizontal: 0, paddingTop: spacing.lg },
  row: { paddingHorizontal: 0 },
});
