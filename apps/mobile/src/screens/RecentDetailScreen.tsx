/**
 * Detail / preview / delete screen for one entry in the recents list.
 *
 * Read-only this iteration — the body is rendered with
 * react-native-markdown-display, the YAML frontmatter is stripped before
 * display, and the only mutation is the soft-delete Delete button (which
 * archives the .md + any paired binary, then drops the entry from the
 * recents history).
 *
 * Inline edit, retro-enrich, and browse-by-kind are explicit follow-up PRs;
 * see .claude/PRPs/plans/recents-screen-preview-delete.plan.md "NOT Building".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Dialog,
  type MD3Theme,
  Portal,
  Text,
  useTheme,
} from "react-native-paper";
import Markdown from "react-native-markdown-display";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import {
  extractFrontmatterField,
  injectImageEmbed,
  moveToArchive,
  readNote,
  readPairedBinaryFromNote,
  stripFrontmatter,
  updateNote,
} from "../lib/writer";
import { enrichSharedImage } from "../lib/omniroute";
import { removeFromHistory, type CaptureEntry } from "../lib/storage";

type Props = NativeStackScreenProps<RootStackParamList, "RecentDetail">;

export default function RecentDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { entry } = route.params;

  const [body, setBody] = useState<string>("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [reEnriching, setReEnriching] = useState(false);
  const [reEnrichError, setReEnrichError] = useState<string | null>(null);
  // Guard against fast double-taps on Delete — the in-flight archive can
  // race with a second handler call and produce a confusing UI state.
  const deletingRef = useRef(false);
  // Same guard for the Re-enrich button — re-running the LLM call twice
  // would write the .md twice, with whichever finishes second winning.
  const reEnrichingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const content = await readNote(entry.filepath);
        if (!mounted) return;
        setBody(content);
      } catch {
        // Most common cause: user renamed or deleted the note in Obsidian
        // since carnet captured it. Show the missing-file banner instead
        // of an opaque error.
        if (!mounted) return;
        setMissing(true);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [entry.filepath]);

  const handleDelete = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setConfirmVisible(false);
    try {
      await moveToArchive(entry.filepath);
    } catch (e: unknown) {
      // Best-effort archive: even on failure, drop the entry from history
      // so the user isn't stuck staring at a ghost row.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] archive failed:", msg);
    }
    try {
      await removeFromHistory(entry.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] removeFromHistory failed:", msg);
    }
    navigation.goBack();
  }, [entry.filepath, entry.id, navigation]);

  const handleRemoveFromHistory = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    await removeFromHistory(entry.id);
    navigation.goBack();
  }, [entry.id, navigation]);

  const handleReEnrich = useCallback(async () => {
    if (reEnrichingRef.current) return;
    reEnrichingRef.current = true;
    setReEnrichError(null);
    setReEnriching(true);
    try {
      // Locate the paired image. The match also tells us the relative path
      // we need to re-inject after the LLM rewrites the body.
      const linkMatch = body.match(/\.\.\/Photos\/([^/\s)]+)/);
      if (!linkMatch) {
        throw new Error(
          "No paired image found in this note — re-enrich needs the original image on disk.",
        );
      }
      const imageFilename = linkMatch[1];
      const { base64, mime } = await readPairedBinaryFromNote(body);
      // Re-enrich uses an empty context — the original context-at-capture
      // isn't recoverable from the saved markdown without a brittle parse.
      // A future PR can add a TextInput to let the user supply fresh context.
      const result = await enrichSharedImage({
        base64,
        mimeType: mime,
        context: "",
      });
      const withImage = injectImageEmbed(
        result.markdown,
        `../Photos/${imageFilename}`,
      );
      await updateNote(entry.filepath, withImage);
      setBody(withImage);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] re-enrich failed:", reason);
      setReEnrichError(reason);
    } finally {
      reEnrichingRef.current = false;
      setReEnriching(false);
    }
  }, [body, entry.filepath]);

  // Re-enrich only makes sense when the raw input is recoverable from disk.
  // That's photo + shared-image (paired JPEG in Photos/). idea/journal/person
  // notes have no raw input on disk — the enriched body is the only artifact.
  // shared-link/text need a frontmatter migration first (follow-up PR).
  const kind = extractFrontmatterField(body, "kind") ?? "";
  const canReEnrich = kind === "shared-image" || kind === "photo";

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  // Strip YAML frontmatter so the renderer doesn't show the `---` raw block.
  // The metadata is already presented in the header card.
  const renderBody = stripFrontmatter(body);

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        {missing ? (
          <Banner
            visible
            icon="alert"
            actions={[
              {
                label: "Remove from recents",
                onPress: handleRemoveFromHistory,
              },
            ]}
          >
            This note was edited or deleted outside carnet.
          </Banner>
        ) : null}

        {reEnrichError ? (
          <Banner visible icon="alert" actions={[]}>
            {`Re-enrich failed: ${reEnrichError}`}
          </Banner>
        ) : null}

        {reEnriching ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator />
            <Text variant="bodySmall" style={styles.dim}>
              Re-running vision enrichment…
            </Text>
          </View>
        ) : null}

        <Card style={styles.card}>
          <Card.Title
            title={entry.title}
            subtitle={`${formatMode(entry.mode)} · ${formatDate(entry.createdAt)}`}
          />
          <Card.Content>
            <Text variant="bodySmall" selectable style={styles.path}>
              {entry.filepath}
            </Text>
          </Card.Content>
        </Card>

        {!missing ? (
          <Card style={styles.card}>
            <Card.Content>
              <Markdown style={markdownStyle(theme)}>{renderBody}</Markdown>
            </Card.Content>
          </Card>
        ) : null}

        <Card style={styles.card}>
          <Card.Actions>
            {canReEnrich ? (
              <Button
                mode="text"
                icon="auto-fix"
                onPress={handleReEnrich}
                disabled={missing || reEnriching}
              >
                Re-enrich
              </Button>
            ) : null}
            <Button
              mode="text"
              icon="delete"
              textColor={theme.colors.error}
              onPress={() => setConfirmVisible(true)}
              disabled={missing || reEnriching}
            >
              Delete
            </Button>
          </Card.Actions>
        </Card>
      </ScrollView>

      <Portal>
        <Dialog
          visible={confirmVisible}
          onDismiss={() => setConfirmVisible(false)}
        >
          <Dialog.Title>Move to Archive?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              The note and any paired file will be moved to Archive/. You can
              recover them by browsing the vault in Obsidian.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
            <Button onPress={handleDelete} textColor={theme.colors.error}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
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

function formatDate(unix: number): string {
  return new Date(unix).toLocaleString();
}

// Theme-aware markdown styles. fontFamily intentionally omitted — some
// emoji and accented chars crash on Android when a custom family is set
// and the platform default handles them cleanly.
function markdownStyle(theme: MD3Theme) {
  return {
    body: { color: theme.colors.onSurface, fontSize: 15, lineHeight: 22 },
    heading1: {
      color: theme.colors.onSurface,
      fontWeight: "700" as const,
      marginTop: 12,
      fontSize: 22,
    },
    heading2: {
      color: theme.colors.onSurface,
      fontWeight: "600" as const,
      marginTop: 10,
      fontSize: 18,
    },
    heading3: {
      color: theme.colors.onSurface,
      fontWeight: "600" as const,
      marginTop: 8,
      fontSize: 16,
    },
    code_inline: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 2,
      borderRadius: 4,
    },
    code_block: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 8,
      borderRadius: 6,
    },
    fence: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 8,
      borderRadius: 6,
    },
    link: { color: theme.colors.primary },
    bullet_list: { marginTop: 6 },
    ordered_list: { marginTop: 6 },
  };
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { marginTop: 4 },
  path: { opacity: 0.6, fontFamily: "monospace" },
  dim: { opacity: 0.6 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  inlineLoading: {
    paddingVertical: 16,
    alignItems: "center",
    gap: 6,
  },
});
