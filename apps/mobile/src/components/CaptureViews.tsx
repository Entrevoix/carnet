import { StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  Card,
  Chip,
  HelperText,
  Modal,
  Portal,
  Text,
} from "react-native-paper";

import { TagInput } from "./TagInput";
import { LocationChip } from "./LocationChip";
import { useCarnetTheme } from "../lib/theme";
import type { PickedAttachment } from "../lib/attachments";
import { IDEA_STATUSES, type IdeaStatus } from "@carnet/shared";

interface CaptureMetaSheetProps {
  visible: boolean;
  onDismiss: () => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  knownTags: string[];
  location: string | null;
  onLocationChange: (location: string | null) => void;
  /** Attachments are Idea/Journal only — hidden for Person captures. */
  showAttachments: boolean;
  pending: PickedAttachment[];
  onAddAttachment: (imagesOnly: boolean) => void;
  onRemoveAttachment: (index: number) => void;
}

/** The "+" metadata bottom sheet: tags, location, and (Idea/Journal) staged
 * attachments. Purely presentational — CaptureScreen owns all the state and
 * threads it in. */
export function CaptureMetaSheet({
  visible,
  onDismiss,
  tags,
  onTagsChange,
  knownTags,
  location,
  onLocationChange,
  showAttachments,
  pending,
  onAddAttachment,
  onRemoveAttachment,
}: CaptureMetaSheetProps) {
  const theme = useCarnetTheme();
  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.metaSheet,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.outline,
            borderTopLeftRadius: theme.carnet.radius.sheet,
            borderTopRightRadius: theme.carnet.radius.sheet,
            padding: theme.carnet.spacing.lg,
            gap: theme.carnet.spacing.md,
          },
        ]}
      >
        <Text variant="titleMedium">Tags & details</Text>
        <TagInput tags={tags} onChange={onTagsChange} knownTags={knownTags} />
        <LocationChip location={location} onChange={onLocationChange} />
        {showAttachments && (
          <View style={styles.attachBlock}>
            <View style={styles.attachRow}>
              <Button
                icon="image"
                mode="contained-tonal"
                compact
                onPress={() => onAddAttachment(true)}
              >
                Image
              </Button>
              <Button
                icon="paperclip"
                mode="contained-tonal"
                compact
                onPress={() => onAddAttachment(false)}
              >
                File
              </Button>
            </View>
            {pending.length > 0 && (
              <View style={styles.chipRow}>
                {pending.map((p, i) => (
                  <Chip
                    key={`${p.filename}-${i}`}
                    icon={p.kind === "image" ? "image" : "file"}
                    onClose={() => onRemoveAttachment(i)}
                    compact
                  >
                    {p.filename}
                  </Chip>
                ))}
              </View>
            )}
          </View>
        )}
        <Button mode="text" onPress={onDismiss}>
          Done
        </Button>
      </Modal>
    </Portal>
  );
}

interface CapturePreviewCardProps {
  /** `Ideas/x.md • model` — the target filename + enriching model line. */
  subtitle: string;
  previewMarkdown: string;
  /** Status chips are Idea-only. */
  showStatusRow: boolean;
  currentStatus: string | null;
  onPromote: (status: IdeaStatus) => void;
  showSource: boolean;
  onToggleSource: () => void;
  onSave: () => void;
  error: string | null;
}

/** The blocking-preview card (enrich → preview → Save) for Idea (opt-in),
 * Journal, and Person. Presentational — CaptureScreen owns the pending data
 * and the save/promote handlers. */
export function CapturePreviewCard({
  subtitle,
  previewMarkdown,
  showStatusRow,
  currentStatus,
  onPromote,
  showSource,
  onToggleSource,
  onSave,
  error,
}: CapturePreviewCardProps) {
  return (
    <Card style={styles.previewCard}>
      <Card.Title title="Preview" subtitle={subtitle} />
      <Card.Content>
        {showStatusRow && (
          <View style={styles.statusRow}>
            {IDEA_STATUSES.map((s) => (
              <Chip
                key={s}
                selected={currentStatus === s}
                onPress={() => onPromote(s)}
                style={styles.statusChip}
                compact
              >
                {s}
              </Chip>
            ))}
          </View>
        )}
        <Text selectable style={showSource ? styles.previewSource : styles.previewRendered}>
          {previewMarkdown}
        </Text>
      </Card.Content>
      <Card.Actions>
        <Button mode="text" compact onPress={onToggleSource}>
          {showSource ? "View rendered" : "View source"}
        </Button>
        <Button onPress={onSave} mode="contained">
          Save
        </Button>
      </Card.Actions>
      {error && (
        <Card.Content>
          <HelperText type="error" visible>
            {error}
          </HelperText>
        </Card.Content>
      )}
    </Card>
  );
}

interface CaptureSavedCardProps {
  /** Permanent enrichment failure — raw note kept, Re-enrich offered. */
  degradedReason: string | null;
  /** Info line (queued offline, or conflict-kept-your-version). */
  enrichNotice: string | null;
  savedFilepath: string | null;
  onReEnrich: () => void;
  onDone: () => void;
}

/** The save-first "Saved to vault" confirmation card, shown only when the Idea
 * landed in a degraded (permanent failure) or notice (queued/conflict) state.
 * Presentational — CaptureScreen owns the outcome state and the re-enrich flow. */
export function CaptureSavedCard({
  degradedReason,
  enrichNotice,
  savedFilepath,
  onReEnrich,
  onDone,
}: CaptureSavedCardProps) {
  return (
    <Card style={styles.previewCard}>
      <Card.Title title="Saved to vault" />
      <Card.Content>
        {degradedReason ? (
          <Banner visible icon="alert" actions={[]} style={styles.degradedBanner}>
            {`Your note is safe in the vault. Tidying it up didn't work (${degradedReason}) — tap Re-enrich to try again, or just edit it in Obsidian.`}
          </Banner>
        ) : null}
        {enrichNotice ? (
          <Banner visible icon="information" actions={[]} style={styles.degradedBanner}>
            {enrichNotice}
          </Banner>
        ) : null}
        <Text variant="bodySmall" selectable style={styles.previewRendered}>
          {savedFilepath ?? ""}
        </Text>
        <HelperText type="info" visible>
          Open Obsidian (or your editor) on the synced folder to read and edit.
          Carnet is intake-only.
        </HelperText>
      </Card.Content>
      <Card.Actions>
        {degradedReason ? (
          <Button mode="text" onPress={onReEnrich}>
            Re-enrich
          </Button>
        ) : null}
        <Button mode="contained" onPress={onDone}>
          Done
        </Button>
      </Card.Actions>
    </Card>
  );
}

const styles = StyleSheet.create({
  metaSheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderWidth: 1 },
  attachBlock: { gap: 8 },
  attachRow: { flexDirection: "row", gap: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  previewCard: { marginTop: 8 },
  previewSource: { fontFamily: "monospace", fontSize: 12, marginTop: 12 },
  previewRendered: { fontSize: 13, lineHeight: 20, marginTop: 12 },
  statusRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  statusChip: {},
  degradedBanner: { marginBottom: 8 },
});
