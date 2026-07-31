import { FlatList, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  HelperText,
  IconButton,
  List,
  Modal,
  Portal,
  Text,
  TextInput,
} from "react-native-paper";

import { caretProps, type CarnetTheme } from "../lib/theme";

interface ModelBrowserModalProps {
  theme: CarnetTheme;
  /** Whether the modal is open. */
  visible: boolean;
  onDismiss: () => void;
  /** True while the GET /v1/models fetch for the current open is in flight. */
  loading: boolean;
  /** Set when the fetch failed; shows the error + a Retry button instead of the list. */
  error: string | null;
  onRetry: () => void;
  /** Substring filter, already applied to `recommended`/`others` by the caller. */
  filter: string;
  onFilterChange: (next: string) => void;
  /** Recommended-for-carnet models present in the (filtered) catalog, pinned
   * above the rest — see filterAndSplitModels. */
  recommended: string[];
  /** Everything else in the (filtered) catalog. */
  others: string[];
  onPickModel: (id: string) => void;
}

/**
 * Settings → model browser: a modal listing available models from
 * GET /v1/models so the user can pick a chat or vision model from the
 * actual catalog instead of guessing a name. Purely presentational — all
 * fetch/filter/pick state and logic live in SettingsScreen (via
 * lib/modelBrowser.ts and lib/dispatcher.ts); this component only renders
 * whatever it's handed and reports picks/dismiss/retry back up.
 */
export function ModelBrowserModal({
  theme,
  visible,
  onDismiss,
  loading,
  error,
  onRetry,
  filter,
  onFilterChange,
  recommended,
  others,
  onPickModel,
}: ModelBrowserModalProps) {
  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.browseModal,
          { backgroundColor: theme.colors.surface },
        ]}
      >
        <View style={styles.browseHeader}>
          <Text variant="titleMedium">Available models</Text>
          <IconButton
            icon="close"
            onPress={onDismiss}
            accessibilityLabel="Close model browser"
          />
        </View>
        {loading ? (
          <View style={styles.browseLoading}>
            <ActivityIndicator />
            <Text style={styles.browseLoadingText}>Fetching catalog…</Text>
          </View>
        ) : error ? (
          <View style={styles.browseBody}>
            <HelperText type="error" visible>
              {error}
            </HelperText>
            <Button mode="contained-tonal" onPress={onRetry}>
              Retry
            </Button>
          </View>
        ) : (
          <View style={styles.browseBody}>
            <TextInput
              {...caretProps(theme)}
              mode="outlined"
              placeholder="Filter (e.g. claude, gemini, gpt)"
              autoCapitalize="none"
              autoCorrect={false}
              value={filter}
              onChangeText={onFilterChange}
              dense
            />
            <Text variant="bodySmall" style={styles.browseCount}>
              {recommended.length + others.length} model
              {recommended.length + others.length === 1 ? "" : "s"}
              {filter ? ` matching “${filter}”` : ""}
            </Text>
            <FlatList
              data={others}
              keyExtractor={(item) => item}
              style={styles.browseList}
              ListHeaderComponent={
                recommended.length > 0 ? (
                  <View>
                    <List.Subheader style={styles.browseSubheader}>
                      Recommended for carnet
                    </List.Subheader>
                    {recommended.map((item) => (
                      <List.Item
                        key={item}
                        title={item}
                        titleNumberOfLines={2}
                        onPress={() => onPickModel(item)}
                        style={styles.browseRow}
                        left={(p) => <List.Icon {...p} icon="star" />}
                      />
                    ))}
                    {others.length > 0 && (
                      <List.Subheader style={styles.browseSubheader}>
                        All available
                      </List.Subheader>
                    )}
                  </View>
                ) : null
              }
              renderItem={({ item }) => (
                <List.Item
                  title={item}
                  titleNumberOfLines={2}
                  onPress={() => onPickModel(item)}
                  style={styles.browseRow}
                />
              )}
              ListEmptyComponent={
                recommended.length === 0 ? (
                  <Text style={styles.browseEmpty}>No models match.</Text>
                ) : null
              }
            />
          </View>
        )}
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  browseModal: {
    backgroundColor: "white",
    margin: 16,
    borderRadius: 12,
    maxHeight: "85%",
    overflow: "hidden",
  },
  browseHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 16,
  },
  browseBody: { padding: 16, gap: 8, flexShrink: 1 },
  browseList: { flexGrow: 0, maxHeight: 480 },
  browseRow: { paddingVertical: 0 },
  browseLoading: { padding: 32, alignItems: "center", gap: 8 },
  browseLoadingText: { opacity: 0.7 },
  browseCount: { opacity: 0.6, paddingHorizontal: 4 },
  browseSubheader: { paddingHorizontal: 0, paddingTop: 4 },
  browseEmpty: { textAlign: "center", opacity: 0.6, padding: 24 },
});
