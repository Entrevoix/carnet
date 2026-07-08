/**
 * Vault search — the browse-mode omnibox. One pill searchbar over the note
 * index (title → tags → excerpt, prefix ahead of substring, newest-first on
 * ties). Filters (mode + top tags) live behind the bar's filter icon and
 * collapse after use — never permanently docked; active filters render as
 * dismissible stamps under the bar. An empty query browses the whole vault
 * newest-first. Results are NoteCards — the same visual grammar as Home.
 * The index is read cache-first (instant); pull-to-refresh forces a rebuild.
 * Tapping a result resolves the note into a CaptureEntry and opens
 * RecentDetail.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Searchbar, Text } from "react-native-paper";
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
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { NoteCard, modeStamp } from "../components/NoteCard";
import { StampChip } from "../components/StampChip";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;

/** Modes that can appear in the note index (one per note subdir). */
const MODE_FILTERS: readonly CaptureMode[] = ["idea", "journal", "person"];

/** Max tag pills offered in the expanded filter row — the most-used tags
 * carry most taps; everything else is reachable by typing. */
const MAX_TAG_PILLS = 6;

export default function SearchScreen({ route, navigation }: Props) {
  const theme = useCarnetTheme();
  const [index, setIndex] = useState<NoteIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<CaptureMode | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>(
    route.params?.tag ? [route.params.tag] : [],
  );
  // Filter pills are hidden until the user asks for them (goal 4: filters
  // collapse into pills only when tapped, never permanently docked).
  const [filtersOpen, setFiltersOpen] = useState(false);

  // A tag tapped elsewhere (TagBrowser, note detail) navigates here with a
  // param — fold it into the active filters when it changes.
  useEffect(() => {
    const tag = route.params?.tag;
    if (!tag) return;
    setTagFilters((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  }, [route.params?.tag]);

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

  // Most-used tags for the expanded filter row, derived from the index.
  const topTags = useMemo<string[]>(() => {
    if (!index) return [];
    const counts = new Map<string, number>();
    for (const note of index.notes) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAG_PILLS)
      .map(([tag]) => tag);
  }, [index]);

  const results = useMemo<NoteIndexEntry[]>(() => {
    if (!index) return [];
    const base = searchNotes(index, query, modeFilter ? { mode: modeFilter } : {});
    if (tagFilters.length === 0) return base;
    return base.filter((n) => tagFilters.every((t) => n.tags.includes(t)));
  }, [index, query, modeFilter, tagFilters]);

  const toggleTag = useCallback((tag: string) => {
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  const openNote = useCallback(
    async (uri: string) => {
      const entry = await resolveNoteEntry(uri);
      if (entry) navigation.navigate("RecentDetail", { entry });
    },
    [navigation],
  );

  const hasActiveFilters = modeFilter !== null || tagFilters.length > 0;

  const renderItem = useCallback(
    ({ item }: { item: NoteIndexEntry }) => (
      <NoteCard
        title={item.title}
        mode={item.mode}
        createdAt={item.createdOrDate || undefined}
        excerpt={item.excerpt}
        tags={item.tags}
        pendingEnrich={item.status === "pending-enrich"}
        onPress={() => void openNote(item.uri)}
      />
    ),
    [openNote],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View
        style={[
          styles.header,
          { padding: theme.carnet.spacing.md, gap: theme.carnet.spacing.sm },
        ]}
      >
        <Searchbar
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          traileringIcon={filtersOpen ? "filter-variant-remove" : "filter-variant"}
          onTraileringIconPress={() => setFiltersOpen((v) => !v)}
          style={{ borderRadius: theme.carnet.radius.pill }}
        />

        {/* Expanded filter pills — visible only while the user is picking. */}
        {filtersOpen && (
          <View style={[styles.pillRow, { gap: theme.carnet.spacing.sm }]}>
            {MODE_FILTERS.map((mode) => {
              const { label, icon } = modeStamp(mode);
              const active = modeFilter === mode;
              return (
                <Pressable
                  key={mode}
                  style={styles.pillHit}
                  onPress={() => {
                    setModeFilter((prev) => (prev === mode ? null : mode));
                    setFiltersOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by ${label}`}
                >
                  <StampChip label={label} icon={icon} tone={active ? "accent" : "neutral"} />
                </Pressable>
              );
            })}
            {topTags.map((tag) => {
              const active = tagFilters.includes(tag);
              return (
                <Pressable
                  key={tag}
                  style={styles.pillHit}
                  onPress={() => {
                    toggleTag(tag);
                    setFiltersOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by tag ${tag}`}
                >
                  <StampChip label={`#${tag}`} tone={active ? "accent" : "neutral"} />
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Active filters — dismissible stamps, shown whenever set. */}
        {!filtersOpen && hasActiveFilters && (
          <View style={[styles.pillRow, { gap: theme.carnet.spacing.sm }]}>
            {modeFilter && (
              <Pressable
                style={styles.pillHit}
                onPress={() => setModeFilter(null)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${modeStamp(modeFilter).label} filter`}
              >
                <StampChip label={modeStamp(modeFilter).label} icon="close" />
              </Pressable>
            )}
            {tagFilters.map((tag) => (
              <Pressable
                key={tag}
                style={styles.pillHit}
                onPress={() => toggleTag(tag)}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag filter ${tag}`}
              >
                <StampChip label={`#${tag}`} icon="close" />
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {loading ? (
        <View
          style={{ padding: theme.carnet.spacing.lg, gap: theme.carnet.spacing.md }}
        >
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.skeletonCard,
                {
                  backgroundColor: theme.colors.surfaceVariant,
                  borderRadius: theme.carnet.radius.card,
                },
              ]}
            />
          ))}
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.uri}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            results.length === 0 ? styles.center : null,
            {
              paddingHorizontal: theme.carnet.spacing.md,
              paddingBottom: theme.carnet.spacing.xl,
              gap: theme.carnet.spacing.md,
            },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {query.trim() || hasActiveFilters
                ? "Nothing matches — try fewer filters or different words."
                : "No notes yet — capture something first."}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {},
  pillRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  // The stamp glyph is small by design; the touch target must not be
  // (DESIGN.md: 48dp minimum) — pad the Pressable, not the stamp.
  pillHit: { minHeight: MIN_TAP_TARGET, justifyContent: "center" },
  skeletonCard: { height: 96 },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
