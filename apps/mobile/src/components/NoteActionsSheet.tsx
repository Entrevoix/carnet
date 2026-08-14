import { StyleSheet, View } from "react-native";
import { List, Modal } from "react-native-paper";

import { MIN_TAP_TARGET, type CarnetTheme } from "../lib/theme";

interface NoteActionsSheetProps {
  theme: CarnetTheme;
  visible: boolean;
  onDismiss: () => void;
  /** Kind-gated rows (see lib/recentDetailView.ts noteCapabilities). */
  canReEnrich: boolean;
  canTranscribe: boolean;
  /** Not kind-gated — false only when the .md is gone from disk. */
  canEnhance: boolean;
  /** True for a raw save-first capture still carrying `status: pending-enrich`.
   * Body-derived rather than kind-gated, so it is computed by the screen (see
   * lib/finishEnrichment.ts isPendingEnrich) rather than noteCapabilities. */
  canFinishEnrichment: boolean;
  /** Gated on a non-blank Karakeep instance URL in Settings. */
  karakeepConfigured: boolean;
  /** True while any long-running action is in flight. */
  actionsBusy: boolean;
  /** True when the .md is gone from disk — nothing destructive may run. */
  missing: boolean;
  onAttachPhoto: () => void;
  onReEnrich: () => void;
  onFinishEnrichment: () => void;
  onTranscribe: () => void;
  onEnhance: () => void;
  onSendToKarakeep: () => void;
  onFileInfo: () => void;
  onDelete: () => void;
}

/**
 * Secondary-actions sheet behind the header overflow (⋮). Edit is the screen's
 * single primary action (the FAB), so everything else lives here. Delete sits
 * last, stamp-red, separated by a divider from the non-destructive rows.
 *
 * Callers wrap this in their own <Portal>.
 */
export function NoteActionsSheet({
  theme,
  visible,
  onDismiss,
  canReEnrich,
  canTranscribe,
  canEnhance,
  canFinishEnrichment,
  karakeepConfigured,
  actionsBusy,
  missing,
  onAttachPhoto,
  onReEnrich,
  onFinishEnrichment,
  onTranscribe,
  onEnhance,
  onSendToKarakeep,
  onFileInfo,
  onDelete,
}: NoteActionsSheetProps) {
  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      contentContainerStyle={[
        styles.sheet,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.outline,
          borderTopLeftRadius: theme.carnet.radius.sheet,
          borderTopRightRadius: theme.carnet.radius.sheet,
          paddingVertical: theme.carnet.spacing.md,
        },
      ]}
    >
      {canEnhance ? (
        <List.Item
          title="Enhance"
          description="Rewrite this entry's prose with a stronger model"
          left={(p) => <List.Icon {...p} icon="feather" />}
          disabled={actionsBusy || missing}
          onPress={onEnhance}
          style={styles.sheetRow}
        />
      ) : null}
      <List.Item
        title="Attach photo"
        description="Photograph something and add it to this entry"
        left={(p) => <List.Icon {...p} icon="camera-plus-outline" />}
        disabled={actionsBusy || missing}
        onPress={onAttachPhoto}
        style={styles.sheetRow}
      />
      {canReEnrich ? (
        <List.Item
          title="Re-enrich"
          description="Re-run AI enrichment on the original image"
          left={(p) => <List.Icon {...p} icon="auto-fix" />}
          disabled={actionsBusy}
          onPress={onReEnrich}
          style={styles.sheetRow}
        />
      ) : null}
      {canFinishEnrichment ? (
        <List.Item
          title="Finish enrichment"
          description="This note was saved raw and never enriched — add its title and tags now"
          left={(p) => <List.Icon {...p} icon="sync-alert" />}
          disabled={actionsBusy}
          onPress={onFinishEnrichment}
          style={styles.sheetRow}
        />
      ) : null}
      {canTranscribe ? (
        <List.Item
          title="Transcribe"
          description="Turn the audio into a text transcript"
          left={(p) => <List.Icon {...p} icon="text-recognition" />}
          disabled={actionsBusy}
          onPress={onTranscribe}
          style={styles.sheetRow}
        />
      ) : null}
      {karakeepConfigured ? (
        <List.Item
          title="Send to Karakeep"
          description="Bookmark this note on your Karakeep instance"
          left={(p) => <List.Icon {...p} icon="bookmark-plus-outline" />}
          disabled={actionsBusy || missing}
          onPress={onSendToKarakeep}
          style={styles.sheetRow}
        />
      ) : null}
      <List.Item
        title="File info"
        description="Where this note lives in the vault"
        left={(p) => <List.Icon {...p} icon="file-document-outline" />}
        onPress={onFileInfo}
        style={styles.sheetRow}
      />
      <View style={[styles.sheetDivider, { backgroundColor: theme.colors.outline }]} />
      <List.Item
        title="Delete"
        description="Move the note to Archive/"
        titleStyle={{ color: theme.colors.error }}
        left={(p) => <List.Icon {...p} icon="delete" color={theme.colors.error} />}
        disabled={actionsBusy || missing}
        onPress={onDelete}
        style={styles.sheetRow}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderWidth: 1 },
  sheetRow: { minHeight: MIN_TAP_TARGET },
  sheetDivider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
