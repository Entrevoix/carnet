import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { modeStamp } from "./NoteCard";
import { StampChip } from "./StampChip";
import type { CaptureEntry } from "../lib/storage";
import { MIN_TAP_TARGET, type CarnetTheme } from "../lib/theme";

interface NoteMetaRowProps {
  theme: CarnetTheme;
  mode: CaptureEntry["mode"];
  tags: string[];
  /** `lat,lon` from frontmatter, or null when the note carries no location. */
  location: string | null;
  /** True while the note is still queued for AI enrichment. */
  pendingEnrich: boolean;
  /** Already-formatted capture timestamp. */
  capturedAt: string;
  onTagPress: (tag: string) => void;
  onLocationPress: (location: string) => void;
}

/**
 * The note's metadata as one quiet stamp row — mode, tags, location, pending
 * status, capture date. The reading surface starts immediately below it; the
 * raw file path deliberately lives in the File info dialog instead.
 */
export function NoteMetaRow({
  theme,
  mode,
  tags,
  location,
  pendingEnrich,
  capturedAt,
  onTagPress,
  onLocationPress,
}: NoteMetaRowProps) {
  return (
    <View style={[styles.metaRow, { gap: theme.carnet.spacing.sm }]}>
      <StampChip label={modeStamp(mode).label} icon={modeStamp(mode).icon} />
      {tags.map((tag) => (
        <Pressable
          key={tag}
          style={styles.stampHit}
          onPress={() => onTagPress(tag)}
          accessibilityRole="button"
          accessibilityLabel={`Search notes tagged ${tag}`}
        >
          <StampChip label={`#${tag}`} />
        </Pressable>
      ))}
      {location ? (
        <Pressable
          style={styles.stampHit}
          onPress={() => onLocationPress(location)}
          accessibilityRole="button"
          accessibilityLabel="Open location in maps"
        >
          <StampChip label="location" icon="map-marker" />
        </Pressable>
      ) : null}
      {pendingEnrich ? <StampChip label="pending" icon="sync" tone="stamp" /> : null}
      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {capturedAt}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  stampHit: { minHeight: MIN_TAP_TARGET, justifyContent: "center" },
});
