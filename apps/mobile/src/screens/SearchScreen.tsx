/**
 * Vault search. A single text field over the note index (title → tags →
 * excerpt, prefix ahead of substring, newest-first on ties) with mode filter
 * chips. The index is read cache-first (instant); pull-to-refresh forces a
 * rebuild. Tapping a result resolves the note into a CaptureEntry and opens
 * RecentDetail — exactly the way the tag browser does.
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { ActivityIndicator, Chip, Divider, List, Searchbar, Text, useTheme } from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import type { CaptureMode } from "../lib/storage";
import {
  getNoteIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNotes,
  type NoteIndex,
  type NoteIndexEntry,
} from "../lib/vault";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;

/** Modes that can appear in the note index (one per note subdir). */
const MODE_FILTERS: readonly CaptureMode[] = ["idea", "journal", "person"];

function modeLabel(mode: CaptureMode): string {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "Contact";
  return "Idea";
}

function modeIcon(mode: CaptureMode): string {
  if (mode === "journal") return "notebook-outline";
  if (mode === "person") return "account-outline";
  return "lightbulb-outline";
}

export default function SearchScreen({ navigation }: Props) {
  const theme = useTheme();
  const [index, setIndex] = useState<NoteIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<CaptureMode | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      void getNoteIndex()
        .then((next) => (active ? setIndex(next) : undefined))
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setIndex(await refreshNoteIndex());
    } finally {
      setRefreshing(false);
    }
  }, []);

  const results = useMemo<NoteIndexEntry[]>(() => {
    if (!index) return [];
    return searchNotes(index, query, modeFilter ? { mode: modeFilter } : {});
  }, [index, query, modeFilter]);

  const openNote = useCallback(
    async (uri: string) => {
      const entry = await resolveNoteEntry(uri);
      if (entry) navigation.navigate("RecentDetail", { entry });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item, index: i }: { item: NoteIndexEntry; index: number }) => (
      <View>
        {i > 0 && <Divider />}
        <List.Item
          title={item.title}
          description={item.excerpt ? `${modeLabel(item.mode)} • ${item.excerpt}` : modeLabel(item.mode)}
          descriptionNumberOfLines={2}
          onPress={() => void openNote(item.uri)}
          left={(props) => <List.Icon {...props} icon={modeIcon(item.mode)} />}
        />
      </View>
    ),
    [openNote],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Searchbar
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.chips}>
          <Chip
            selected={modeFilter === null}
            showSelectedCheck={false}
            onPress={() => setModeFilter(null)}
            style={styles.chip}
          >
            All
          </Chip>
          {MODE_FILTERS.map((mode) => (
            <Chip
              key={mode}
              selected={modeFilter === mode}
              showSelectedCheck={false}
              icon={modeIcon(mode)}
              onPress={() => setModeFilter((prev) => (prev === mode ? null : mode))}
              style={styles.chip}
            >
              {modeLabel(mode)}
            </Chip>
          ))}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.uri}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={results.length === 0 ? styles.center : styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {query.trim() ? "No matching notes." : "No notes yet — capture something first."}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { padding: 12, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {},
  list: { paddingVertical: 4 },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
});
