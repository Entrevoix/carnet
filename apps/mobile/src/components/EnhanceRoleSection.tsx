import { StyleSheet } from "react-native";
import { Button, List } from "react-native-paper";

import { spacing } from "../lib/theme";
import { ProviderRoleRow } from "./ProviderRoleRow";

interface EnhanceRoleSectionProps {
  /** Label of the provider Enhance will call, or null when set to None. */
  providerLabel: string | null;
  /** Model id overriding that provider's own, or "" to use the provider's. */
  model: string;
  disabled: boolean;
  onPickProvider: () => void;
  onBrowseModels: () => void;
  onResetModel: () => void;
}

/**
 * The "Enhance" block of the LLM provider settings: which provider the Enhance
 * action calls, and optionally which model on that provider.
 *
 * The two are separate because the interesting case is a different MODEL ON THE
 * SAME ENDPOINT — captures on a fast cheap model, Enhance on a stronger one
 * through the same entry — which a provider-only picker cannot express without
 * duplicating the whole provider.
 *
 * Extracted from LlmProviderSection.tsx, which the model row pushed past this
 * repo's 800-line ceiling. Pure presentation: the section owns state and the
 * immediate persisted writes.
 */
export function EnhanceRoleSection({
  providerLabel,
  model,
  disabled,
  onPickProvider,
  onBrowseModels,
  onResetModel,
}: EnhanceRoleSectionProps) {
  return (
    <>
      <ProviderRoleRow
        title="Enhance model"
        helper="Used by the Enhance action on a saved note. Pick a stronger model than the active one — leave as None to use the active provider."
        providerLabel={providerLabel}
        icon="feather"
        accessibilityLabel="Choose enhance provider"
        disabled={disabled}
        onPress={onPickProvider}
      />
      <List.Item
        title={model || "Same model as that provider"}
        description="Model — tap to browse what that endpoint offers"
        accessibilityLabel="Choose enhance model"
        left={(p) => <List.Icon {...p} icon="tune-variant" />}
        right={(p) => <List.Icon {...p} icon="chevron-down" />}
        onPress={onBrowseModels}
        disabled={disabled}
        style={styles.row}
      />
      {model ? (
        <Button mode="text" compact onPress={onResetModel} style={styles.reset}>
          Reset to provider default
        </Button>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 0 },
  reset: { alignSelf: "flex-start", marginTop: spacing.xs },
});
