import { Keyboard, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Chip,
  HelperText,
  IconButton,
  Modal,
  Portal,
  Text,
} from "react-native-paper";

import { TagInput } from "./TagInput";
import { LocationChip } from "./LocationChip";
import { PlacesEditor } from "./PlacesEditor";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import type { PickedAttachment } from "../lib/attachments";
import type { Place } from "../lib/writer";
import { IDEA_STATUSES, type IdeaStatus } from "@carnet/shared";

interface CaptureActionBarProps {
  /** One quiet summary line for what's staged behind the "+" sheet (tags /
   * attachments / location) — empty string hides the text but keeps the
   * layout slot so Send doesn't shift. */
  metaSummary: string;
  onOpenMeta: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  queueDepth: number;
  error: string | null;
}

/** The distraction-free input's single action bar: metadata tucked behind
 * "+" (never blocks writing), Send as the one filled CTA, plus the
 * queue-depth and error helper lines beneath it. Presentational —
 * CaptureScreen owns all the state and threads it in. */
export function CaptureActionBar({
  metaSummary,
  onOpenMeta,
  onSubmit,
  canSubmit,
  queueDepth,
  error,
}: CaptureActionBarProps) {
  const theme = useCarnetTheme();
  return (
    <>
      <View style={styles.actionBar}>
        <IconButton
          icon="plus-circle-outline"
          size={26}
          onPress={() => {
            // Dismiss the keyboard first: in dark mode a still-open keyboard
            // renders over the near-black sheet and makes it look like the
            // tap did nothing (QA finding).
            Keyboard.dismiss();
            onOpenMeta();
          }}
          accessibilityLabel="Add tags, location, or attachments"
        />
        {metaSummary ? (
          <Text
            variant="labelSmall"
            style={[styles.metaSummary, { color: theme.colors.onSurfaceVariant }]}
            onPress={onOpenMeta}
            numberOfLines={1}
          >
            {metaSummary}
          </Text>
        ) : (
          <View style={styles.metaSummary} />
        )}
        <Button
          mode="contained"
          onPress={onSubmit}
          disabled={!canSubmit}
          contentStyle={styles.sendContent}
        >
          Send
        </Button>
      </View>
      {queueDepth > 0 && (
        <HelperText type="info" visible>
          {queueDepth} capture{queueDepth > 1 ? "s" : ""} waiting for
          enrichment — they'll finish automatically.
        </HelperText>
      )}
      {error && (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      )}
    </>
  );
}

interface CaptureSubmittingViewProps {
  /** Names which backend the "structuring the note…" label attributes the
   * work to, so it never claims a hardcoded provider while a local backend
   * enriches. */
  llmBackend: "omniroute" | "local";
  /** The active (non-local) provider's display name, used when `llmBackend`
   * is "omniroute" — despite the field's name, that branch fires for ANY
   * remote provider (Groq, OpenAI, OpenRouter, a real OmniRoute), so the
   * label must come from the caller rather than being hardcoded here. */
  providerLabel: string;
  onEditInstead: () => void;
}

/** The "submitting" phase: a spinner plus the non-blocking Edit escape hatch
 * (go back to an editable draft instead of waiting out the enrichment now in
 * flight). Presentational — CaptureScreen owns the in-flight request. */
export function CaptureSubmittingView({
  llmBackend,
  providerLabel,
  onEditInstead,
}: CaptureSubmittingViewProps) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator animating size="large" />
      <Text variant="bodyMedium" style={styles.loadingText}>
        {llmBackend === "local"
          ? "Local LLM is structuring the note…"
          : `${providerLabel} is structuring the note…`}
      </Text>
      <Button mode="text" onPress={onEditInstead} accessibilityLabel="Edit before enriching">
        Edit
      </Button>
    </View>
  );
}

interface CaptureMetaSheetProps {
  visible: boolean;
  onDismiss: () => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  knownTags: string[];
  location: string | null;
  onLocationChange: (location: string | null) => void;
  /** Places are Journal only — the section is hidden for Idea/Person. */
  showPlaces: boolean;
  places: Place[];
  onPlacesChange: (places: Place[]) => void;
  /** Attachments are Idea/Journal only — hidden for Person captures. */
  showAttachments: boolean;
  pending: PickedAttachment[];
  /** Attachments already written to disk from an earlier submit in this same
   * capture (e.g. the user tapped Edit mid-enrichment) — `pending` only ever
   * holds picker items still awaiting persist, so without this the sheet
   * showed no attachment at all and a user would reasonably re-attach,
   * creating a real duplicate. Not removable here: removing one would need
   * to unlink it from the file already on disk, which this sheet has no way
   * to do. */
  savedAttachments?: { filename: string; kind: "image" | "file" }[];
  onAddAttachment: (imagesOnly: boolean) => void;
  onRemoveAttachment: (index: number) => void;
}

/** The "+" metadata bottom sheet: tags, location, (Journal) named places, and
 * (Idea/Journal) staged attachments. Purely presentational — CaptureScreen owns all the state and
 * threads it in. */
export function CaptureMetaSheet({
  visible,
  onDismiss,
  tags,
  onTagsChange,
  knownTags,
  location,
  onLocationChange,
  showPlaces,
  places,
  onPlacesChange,
  showAttachments,
  pending,
  savedAttachments = [],
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
        {showPlaces && <PlacesEditor places={places} onChange={onPlacesChange} />}
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
            {(savedAttachments.length > 0 || pending.length > 0) && (
              <View style={styles.chipRow}>
                {savedAttachments.map((a, i) => (
                  <Chip key={`saved-${a.filename}-${i}`} icon={a.kind === "image" ? "image" : "file"} compact>
                    {a.filename} · saved
                  </Chip>
                ))}
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
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    minHeight: MIN_TAP_TARGET,
  },
  metaSummary: { flex: 1 },
  sendContent: { paddingHorizontal: 16 },
  loading: { paddingVertical: 64, alignItems: "center", gap: 12 },
  loadingText: { opacity: 0.8 },
});
