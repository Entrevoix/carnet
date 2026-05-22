import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Divider,
  IconButton,
  List,
  Portal,
  Text,
  useTheme,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import {
  getRecentCaptures,
  removeManyFromHistory,
  type CaptureEntry,
} from "../lib/storage";
import { moveToArchive } from "../lib/writer";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export default function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const [recent, setRecent] = useState<CaptureEntry[]>([]);
  // Selection mode: enter via long-press, toggle rows via tap, auto-exit
  // when selection empties or the screen blurs.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmVisible, setConfirmVisible] = useState(false);
  // Guards against fast double-tap on the bulk-delete confirm so the
  // archive loop doesn't run twice.
  const bulkDeletingRef = useRef(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon="cog"
          onPress={() => navigation.navigate("Settings")}
        />
      ),
    });
  }, [navigation]);

  const refresh = useCallback(async () => {
    const items = await getRecentCaptures();
    setRecent(items);
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const enterSelection = useCallback((id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Auto-exit selection mode when the user deselects the last row.
  // Kept as an effect (rather than inside the updater above) so the side
  // effect doesn't fire twice in React 18+ StrictMode's double-invoke.
  useEffect(() => {
    if (selectionMode && selectedIds.size === 0) {
      setSelectionMode(false);
    }
  }, [selectionMode, selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    if (bulkDeletingRef.current) return;
    bulkDeletingRef.current = true;
    setConfirmVisible(false);
    const ids = Array.from(selectedIds);
    const entries = recent.filter((e) => selectedIds.has(e.id));
    try {
      // Best-effort per item — one SAF revocation shouldn't abort the rest.
      // The intent of bulk delete is "clean up as much as you can."
      const results = await Promise.allSettled(
        entries.map((e) => moveToArchive(e.filepath)),
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.warn(`[Home] archive failed for ${entries[i].filepath}: ${reason}`);
        }
      });
      await removeManyFromHistory(ids);
    } catch (e: unknown) {
      // removeManyFromHistory shouldn't throw under normal conditions, but
      // log if AsyncStorage rejects so the failure isn't silent.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] bulk delete failed:", msg);
    } finally {
      bulkDeletingRef.current = false;
      exitSelection();
      // Fire-and-forget so a rare AsyncStorage rejection doesn't bubble
      // up to the unawaited Button.onPress as an unhandled rejection.
      refresh().catch((re: unknown) => {
        const reason = re instanceof Error ? re.message : String(re);
        console.warn("[Home] refresh after bulk delete failed:", reason);
      });
    }
  }, [selectedIds, recent, refresh, exitSelection]);

  useEffect(() => {
    const unsubFocus = navigation.addListener("focus", () => {
      void refresh();
    });
    // Clear any in-flight selection on screen blur so coming back doesn't
    // strand the user in an ambiguous mid-selection state.
    const unsubBlur = navigation.addListener("blur", () => {
      exitSelection();
    });
    void refresh();
    return () => {
      unsubFocus();
      unsubBlur();
    };
  }, [navigation, refresh, exitSelection]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Button
        mode="contained"
        icon="lightbulb-on"
        onPress={() => navigation.navigate("Capture", { mode: "idea" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Idea
      </Button>
      <Button
        mode="contained-tonal"
        icon="microphone"
        onPress={() => navigation.navigate("Capture", { mode: "journal" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Journal
      </Button>
      <Button
        mode="outlined"
        icon="account-plus"
        onPress={() => navigation.navigate("Capture", { mode: "person" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Contact
      </Button>
      <Button
        mode="outlined"
        icon="camera"
        onPress={() => navigation.navigate("PhotoCapture")}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Photo
      </Button>

      {/* "Continue today's journal" shortcut — skips mode selection */}
      <Button
        mode="text"
        icon="book-open-variant"
        onPress={() => navigation.navigate("Capture", { mode: "journal" })}
        style={styles.journalShortcut}
        compact
      >
        Continue today's journal
      </Button>

      <Divider style={styles.divider} />

      {/* Recents card — supports long-press multi-select bulk delete */}
      <Card style={styles.recentCard}>
        {selectionMode ? (
          <View style={styles.selectionHeader}>
            <IconButton
              icon="close"
              onPress={exitSelection}
              accessibilityLabel="Cancel selection"
            />
            <Text variant="titleMedium" style={styles.selectionTitle}>
              {`${selectedIds.size} selected`}
            </Text>
            <IconButton
              icon="delete"
              iconColor={theme.colors.error}
              onPress={() => setConfirmVisible(true)}
              accessibilityLabel="Delete selected"
            />
          </View>
        ) : (
          <Card.Title title="Recent" />
        )}
        <Card.Content>
          {recent.length === 0 ? (
            <Text variant="bodyMedium" style={styles.emptyHint}>
              No captures yet.
            </Text>
          ) : (
            <View>
              {recent.map((item) => {
                const selected = selectedIds.has(item.id);
                return (
                  <List.Item
                    key={item.id}
                    title={item.title}
                    description={`${formatMode(item.mode)} • ${formatDate(item.createdAt)}`}
                    left={(p) =>
                      selectionMode ? (
                        // Decorative-only — the row's onPress owns the toggle,
                        // so the checkbox tap bubbles to TouchableRipple
                        // instead of risking a double-fire.
                        <Checkbox.Android
                          status={selected ? "checked" : "unchecked"}
                        />
                      ) : (
                        <List.Icon {...p} icon={modeIcon(item.mode)} />
                      )
                    }
                    onPress={() => {
                      if (selectionMode) toggleSelection(item.id);
                      else navigation.navigate("RecentDetail", { entry: item });
                    }}
                    onLongPress={() => enterSelection(item.id)}
                    style={styles.listItem}
                  />
                );
              })}
            </View>
          )}
        </Card.Content>
      </Card>

      <Portal>
        <Dialog
          visible={confirmVisible}
          onDismiss={() => setConfirmVisible(false)}
        >
          <Dialog.Title>{`Move ${selectedIds.size} to Archive?`}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              The selected notes and any paired files will be moved to
              Archive/. You can recover them by browsing the vault in Obsidian.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
            <Button onPress={handleBulkDelete} textColor={theme.colors.error}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

function formatMode(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea":
      return "Idea";
    case "journal":
      return "Journal";
    case "person":
      return "Contact";
    case "photo":
      return "Photo";
  }
}

function modeIcon(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea":
      return "lightbulb-on";
    case "journal":
      return "microphone";
    case "person":
      return "account";
    case "photo":
      return "camera";
  }
}

function formatDate(unix: number): string {
  const d = new Date(unix);
  return d.toLocaleString();
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, gap: 12 },
  button: { borderRadius: 12 },
  buttonContent: { paddingVertical: 16 },
  buttonLabel: { fontSize: 18 },
  journalShortcut: { alignSelf: "flex-start" },
  divider: { marginVertical: 8 },
  recentCard: { marginTop: 4 },
  emptyHint: { opacity: 0.6, paddingVertical: 8 },
  listItem: { paddingHorizontal: 0 },
  selectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 4,
    paddingRight: 8,
  },
  selectionTitle: { flex: 1, marginLeft: 4 },
});
