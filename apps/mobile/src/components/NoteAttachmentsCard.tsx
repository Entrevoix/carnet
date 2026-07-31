import { StyleSheet } from "react-native";
import { Button, Card } from "react-native-paper";

/** A paired binary link resolved to a device-readable storage URI. */
export interface ResolvedAttachment {
  /** The relative link as written in the note (`../Photos/x.jpg`). */
  rel: string;
  filename: string;
  uri: string;
  mime: string;
}

interface NoteAttachmentsCardProps {
  /** Non-image files only — images render inline in the note prose. */
  files: ResolvedAttachment[];
  onOpen: (uri: string) => void;
}

/**
 * Tappable rows for a note's non-image attachments. Images now render inline in
 * the body via the custom markdown image rule, and audio has its own player, so
 * only files land here.
 */
export function NoteAttachmentsCard({ files, onOpen }: NoteAttachmentsCardProps) {
  return (
    <Card style={styles.card}>
      <Card.Title title="Attachments" />
      <Card.Content style={styles.attachmentList}>
        {files.map((a) => (
          <Button
            key={a.rel}
            mode="outlined"
            icon="file-document-outline"
            onPress={() => onOpen(a.uri)}
            contentStyle={styles.attachmentFileContent}
          >
            {a.filename}
          </Button>
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
});
