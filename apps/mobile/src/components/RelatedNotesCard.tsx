import { StyleSheet, View } from "react-native";
import { Button, Card, IconButton } from "react-native-paper";

import { modeStamp } from "./NoteCard";
import type { NoteIndexEntry } from "../lib/vault";

interface RelatedNotesCardProps {
  /** Lexical matches from the cached vault index (lib/relatedNotes.ts). */
  related: NoteIndexEntry[];
  onOpen: (uri: string) => void;
  onLink: (title: string) => void;
}

/**
 * "You've thought about this before" — related notes scored off the cached
 * index. Opening one PUSHES it so Back returns here; the link button persists a
 * [[wikilink]] into the open note instead of navigating.
 */
export function RelatedNotesCard({
  related,
  onOpen,
  onLink,
}: RelatedNotesCardProps) {
  return (
    <Card style={styles.card}>
      <Card.Title title="Related" />
      <Card.Content style={styles.attachmentList}>
        {related.map((r) => (
          <View key={r.uri} style={styles.relatedRow}>
            <Button
              mode="text"
              icon={modeStamp(r.mode).icon}
              onPress={() => onOpen(r.uri)}
              contentStyle={styles.attachmentFileContent}
              style={styles.relatedOpen}
            >
              {r.title}
            </Button>
            <IconButton
              icon="link-plus"
              size={20}
              onPress={() => onLink(r.title)}
              accessibilityLabel={`Link ${r.title} into this note`}
            />
          </View>
        ))}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 4 },
  attachmentList: { gap: 12 },
  attachmentFileContent: {
    flexDirection: "row-reverse",
    justifyContent: "flex-end",
  },
  relatedRow: { flexDirection: "row", alignItems: "center" },
  relatedOpen: { flex: 1 },
});
