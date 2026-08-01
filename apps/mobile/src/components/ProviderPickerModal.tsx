import { ScrollView, StyleSheet, View } from "react-native";
import { IconButton, List, Modal, Portal, Text } from "react-native-paper";

import type { LlmProvider } from "../lib/llmProviders";
import { spacing, type CarnetTheme } from "../lib/theme";

interface ProviderPickerModalProps {
  theme: CarnetTheme;
  visible: boolean;
  onDismiss: () => void;
  /** Heading — differs by which identity id this picker is selecting for
   * ("Choose LLM provider" / "Offline fallback provider" / "Vision
   * provider"). */
  title: string;
  providers: readonly LlmProvider[];
  /** The currently-selected id for whichever identity this picker edits —
   * highlighted with a filled radio icon. `null` highlights the "None" row. */
  selectedId: string | null;
  /** Offers a "None" row above the list — used by the fallback/vision
   * pickers (both are optional); the active-provider picker omits it, since
   * there is always exactly one active provider. */
  allowNone: boolean;
  onSelect: (id: string | null) => void;
  /** Renders a delete affordance on custom (preset === null) rows only —
   * presets can never be deleted (llmProviders.ts's removeProvider throws
   * for one), so this picker doesn't even offer the button for them. */
  onDeleteCustom: (id: string) => void;
}

/**
 * Settings → LLM provider: the shared picker list behind all three identity
 * selectors (active / fallback / vision) — presets first, then custom
 * entries, each row showing its base URL as a subtitle. Reused across all
 * three modes (rather than three near-identical components) because the
 * only real difference between them is whether "None" is offered and what
 * selecting a row does — both handled by the caller via `allowNone`/
 * `onSelect`. Purely presentational: all persistence lives in
 * LlmProviderSection.
 */
export function ProviderPickerModal({
  theme,
  visible,
  onDismiss,
  title,
  providers,
  selectedId,
  allowNone,
  onSelect,
  onDeleteCustom,
}: ProviderPickerModalProps) {
  const presets = providers.filter((p) => p.preset !== null);
  const customs = providers.filter((p) => p.preset === null);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.modal,
          { backgroundColor: theme.colors.surface },
        ]}
      >
        <View style={styles.header}>
          <Text variant="titleMedium">{title}</Text>
          <IconButton
            icon="close"
            onPress={onDismiss}
            accessibilityLabel="Close"
          />
        </View>
        <ScrollView style={styles.list}>
          {allowNone && (
            <List.Item
              title="None"
              description="Disabled"
              onPress={() => onSelect(null)}
              left={(p) => (
                <List.Icon
                  {...p}
                  icon={selectedId === null ? "radiobox-marked" : "radiobox-blank"}
                />
              )}
              style={styles.row}
            />
          )}
          <List.Subheader style={styles.subheader}>Presets</List.Subheader>
          {presets.map((p) => (
            <List.Item
              key={p.id}
              title={p.label}
              description={p.baseUrl || "(no base URL set)"}
              onPress={() => onSelect(p.id)}
              left={(ip) => (
                <List.Icon
                  {...ip}
                  icon={selectedId === p.id ? "radiobox-marked" : "radiobox-blank"}
                />
              )}
              style={styles.row}
            />
          ))}
          {customs.length > 0 && (
            <List.Subheader style={styles.subheader}>Custom</List.Subheader>
          )}
          {customs.map((p) => (
            <List.Item
              key={p.id}
              title={p.label}
              description={p.baseUrl || "(no base URL set)"}
              onPress={() => onSelect(p.id)}
              left={(ip) => (
                <List.Icon
                  {...ip}
                  icon={selectedId === p.id ? "radiobox-marked" : "radiobox-blank"}
                />
              )}
              right={() => (
                <IconButton
                  icon="delete-outline"
                  accessibilityLabel={`Delete ${p.label}`}
                  onPress={() => onDeleteCustom(p.id)}
                />
              )}
              style={styles.row}
            />
          ))}
        </ScrollView>
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  modal: {
    margin: spacing.lg,
    borderRadius: 12,
    maxHeight: "85%",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: spacing.lg,
  },
  list: { flexGrow: 0, maxHeight: 480 },
  row: { paddingVertical: 0 },
  subheader: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
});
