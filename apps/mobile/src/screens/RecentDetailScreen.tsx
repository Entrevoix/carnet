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
import { Image, ScrollView, StyleSheet, View } from "react-native";
import * as Sharing from "expo-sharing";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Dialog,
  IconButton,
  type MD3Theme,
  Portal,
  ProgressBar,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import Markdown from "react-native-markdown-display";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import { deriveTitle } from "@carnet/shared";
import { formatElapsed } from "../lib/shareHelpers";

import type { RootStackParamList } from "../../App";
import {
  extFromMime,
  extractFrontmatterField,
  injectImageEmbed,
  listPairedBinaries,
  moveToArchive,
  readNote,
  readPairedBinaryFromNote,
  readPairedBinaryUri,
  resolvePairedUri,
  slugify,
  stripFrontmatter,
  stripPairedBinaryLinks,
  updateNote,
  upsertSection,
  writeBinary,
} from "../lib/writer";
import {
  applyFormat,
  insertAtCursor,
  type FormatKind,
  type Sel,
} from "../lib/markdownEdit";
import { pickAttachment } from "../lib/attachments";
import { MarkdownToolbar } from "../components/MarkdownToolbar";
import { enrichSharedImage, transcribeAudio } from "../lib/omniroute";
import {
  removeFromHistory,
  updateCaptureTitle,
  type CaptureEntry,
} from "../lib/storage";

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
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  // Edit-mode state. `draft` holds the in-progress textarea content;
  // `editError` surfaces a save failure as a banner; `discardVisible`
  // gates the unsaved-changes dialog.
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  const [discardVisible, setDiscardVisible] = useState(false);
  // Toolbar editing: `selection` tracks the live caret/range (via
  // onSelectionChange) so transforms know what to act on; `forceSelection` is a
  // transient override applied ONLY right after a toolbar action to place the
  // caret, then cleared so the IME owns the caret again (avoids cursor jitter).
  const [selection, setSelection] = useState<Sel>({ start: 0, end: 0 });
  const [forceSelection, setForceSelection] = useState<Sel | null>(null);
  const [preview, setPreview] = useState(false);
  // True only while a save is committing — disables the toolbar so a format/
  // image tap can't mutate `draft` after handleSaveEdit captured it (which
  // would be discarded when the save exits edit mode).
  const [saving, setSaving] = useState(false);
  const insertingImageRef = useRef(false);
  // Guard against fast double-taps on Delete — the in-flight archive can
  // race with a second handler call and produce a confusing UI state.
  const deletingRef = useRef(false);
  // Same guard for the Re-enrich button — re-running the LLM call twice
  // would write the .md twice, with whichever finishes second winning.
  const reEnrichingRef = useRef(false);
  const transcribingRef = useRef(false);
  const savingEditRef = useRef(false);
  // Holds the navigation action that triggered beforeRemove so the
  // discard-confirm dialog can replay it after the user confirms.
  const pendingNavActionRef = useRef<
    Parameters<typeof navigation.dispatch>[0] | null
  >(null);
  // Mounted guard — Back-during-save can unmount before the in-flight
  // updateNote resolves; setState on an unmounted component triggers a
  // React warning. The in-flight write itself still lands on disk.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const handleTranscribe = useCallback(async () => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    setTranscribeError(null);
    setTranscribing(true);
    try {
      // Locate the paired audio file — its filename is needed for the
      // multipart `file` field on Whisper, and the regex doubles as a
      // pre-flight check before we read bytes off disk.
      const linkMatch = body.match(/\.\.\/Audio\/([^/\s)]+)/);
      if (!linkMatch) {
        throw new Error(
          "No paired audio found in this note — transcription needs the original audio on disk.",
        );
      }
      const filename = linkMatch[1];
      const { base64, mime } = await readPairedBinaryFromNote(body);
      const { text } = await transcribeAudio({
        base64,
        mimeType: mime,
        filename,
      });
      const next = upsertSection(body, "Transcript", text);
      await updateNote(entry.filepath, next);
      setBody(next);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] transcribe failed:", reason);
      setTranscribeError(reason);
    } finally {
      transcribingRef.current = false;
      setTranscribing(false);
    }
  }, [body, entry.filepath]);

  // True iff the user is in edit mode AND has typed something different
  // from the on-disk body. Drives the beforeRemove guard + Cancel button's
  // decision to skip the discard dialog when there's nothing to discard.
  const isDirty = editMode && draft !== body;

  const enterEdit = useCallback(() => {
    setDraft(body);
    setEditError(null);
    setSelection({ start: 0, end: 0 });
    setForceSelection(null);
    setPreview(false);
    setEditMode(true);
  }, [body]);

  const exitEdit = useCallback(() => {
    setEditMode(false);
    setDraft("");
    setEditError(null);
    setForceSelection(null);
    setPreview(false);
  }, []);

  /** Apply a toolbar formatting intent to the draft + reposition the caret. */
  const applyFmt = useCallback(
    (kind: FormatKind) => {
      if (savingEditRef.current) return;
      const r = applyFormat(draft, selection, kind);
      setDraft(r.text);
      setSelection(r.selection);
      setForceSelection(r.selection);
    },
    [draft, selection],
  );

  /** Toolbar image button: pick → write to the vault → insert the embed at the
   * caret. Reuses the attachments plumbing; the note is already on disk so the
   * binary is committed immediately. Cancelling the picker writes nothing; but
   * discarding the edit AFTER inserting leaves the written file orphaned in
   * Photos/ (acceptable — it's recoverable in the vault, same as a stub photo). */
  const insertImage = useCallback(async () => {
    if (insertingImageRef.current || savingEditRef.current) return;
    insertingImageRef.current = true;
    setEditError(null);
    try {
      const picked = await pickAttachment({ imagesOnly: true });
      if (!picked) return;
      const ext = extFromMime(picked.mime);
      const base = slugify(picked.filename.replace(/\.[^.]+$/, "")) || "image";
      const { finalName } = await writeBinary(
        "Photos",
        `${base}.${ext}`,
        picked.base64,
        picked.mime,
      );
      const r = insertAtCursor(draft, selection, `![](../Photos/${finalName})`);
      setDraft(r.text);
      setSelection(r.selection);
      setForceSelection(r.selection);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      insertingImageRef.current = false;
    }
  }, [draft, selection]);

  const cancelEdit = useCallback(() => {
    if (isDirty) {
      pendingNavActionRef.current = null;
      setDiscardVisible(true);
      return;
    }
    exitEdit();
  }, [isDirty, exitEdit]);

  const keepEditing = useCallback(() => {
    pendingNavActionRef.current = null;
    setDiscardVisible(false);
  }, []);

  const confirmDiscard = useCallback(() => {
    setDiscardVisible(false);
    const pending = pendingNavActionRef.current;
    pendingNavActionRef.current = null;
    exitEdit();
    if (pending) {
      // Replay the navigation action the user originally requested. The
      // re-fired beforeRemove will see !isDirty and pass through.
      navigation.dispatch(pending);
    }
  }, [exitEdit, navigation]);

  const handleSaveEdit = useCallback(async () => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSaving(true);
    setEditError(null);
    // Disk write owns its own try so a writeAsString failure surfaces as
    // "Save failed" while the recents-title update below stays best-effort.
    // Otherwise an AsyncStorage failure after a successful disk write would
    // mislead the user into thinking nothing was saved.
    try {
      await updateNote(entry.filepath, draft);
      if (!mountedRef.current) {
        savingEditRef.current = false;
        return;
      }
      setBody(draft);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] save edit failed:", reason);
      if (mountedRef.current) {
        setEditError(reason);
        setSaving(false);
      }
      savingEditRef.current = false;
      return;
    }

    // Note is saved at this point. Title update is best-effort — log on
    // failure but don't block UX or revert the disk write.
    const newTitle = deriveTitle(draft) || entry.title;
    if (newTitle !== entry.title) {
      try {
        await updateCaptureTitle(entry.id, newTitle);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn("[RecentDetail] title update failed:", reason);
      }
    }

    if (mountedRef.current) {
      setEditMode(false);
      setDraft("");
      setSaving(false);
    }
    savingEditRef.current = false;
  }, [draft, entry.filepath, entry.id, entry.title]);

  // Unsaved-changes guard. preventDefault + show dialog when the user
  // tries to navigate away with dirty edits. Re-subscribes whenever
  // isDirty changes so the closure always reads the current value.
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e) => {
      if (!isDirty) return;
      e.preventDefault();
      pendingNavActionRef.current = e.data.action;
      setDiscardVisible(true);
    });
    return unsub;
  }, [navigation, isDirty]);

  // ── Audio player (kind === shared-audio) ──────────────────────────────────
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Unload the sound on unmount or note-switch — keeps the audio focus
  // returned to the system and frees the file handle.
  useEffect(() => {
    return () => {
      const s = soundRef.current;
      soundRef.current = null;
      if (s) {
        void s.unloadAsync().catch(() => undefined);
      }
    };
  }, []);

  const togglePlay = useCallback(async () => {
    setPlayerError(null);
    try {
      if (soundRef.current) {
        // Already loaded — just toggle.
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          if (status.isPlaying) {
            await soundRef.current.pauseAsync();
          } else if (status.positionMillis >= (status.durationMillis ?? 0) - 100) {
            // Reached end on prior play — rewind before resuming so a
            // tap on Play after finish replays instead of staying stuck.
            await soundRef.current.setPositionAsync(0);
            await soundRef.current.playAsync();
          } else {
            await soundRef.current.playAsync();
          }
        }
        return;
      }
      // First tap — load + start. Status callback drives the progress bar.
      setPlayerLoading(true);
      const { uri } = await readPairedBinaryUri(body);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, progressUpdateIntervalMillis: 250 },
        (status) => {
          if (!status.isLoaded) return;
          if (!mountedRef.current) return;
          setIsPlaying(status.isPlaying);
          setPositionMs(status.positionMillis);
          setDurationMs(status.durationMillis ?? 0);
          if (status.didJustFinish) {
            // Stay loaded so the next tap replays without re-loading.
            setIsPlaying(false);
          }
        },
      );
      soundRef.current = sound;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] audio playback failed:", reason);
      setPlayerError(reason);
    } finally {
      setPlayerLoading(false);
    }
  }, [body]);

  // ── Attachments (images inline + tappable file rows) ──────────────────────
  // Audio is rendered by the dedicated player above, so it's excluded here.
  // The markdown renderer can't resolve relative/SAF URIs, so we resolve each
  // link to a storage URI in an effect and render from state.
  interface ResolvedAttachment {
    rel: string;
    filename: string;
    uri: string;
    mime: string;
  }
  const [attachments, setAttachments] = useState<ResolvedAttachment[]>([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const links = listPairedBinaries(body).filter((b) => b.subdir !== "Audio");
      const resolved: ResolvedAttachment[] = [];
      for (const link of links) {
        const r = await resolvePairedUri(link.subdir, link.filename);
        if (r) {
          resolved.push({
            rel: link.rel,
            filename: link.filename,
            uri: r.uri,
            mime: r.mime,
          });
        }
      }
      if (active) setAttachments(resolved);
    })();
    return () => {
      active = false;
    };
  }, [body]);

  // Open a non-image attachment via the system share sheet. shareAsync wants a
  // file:// path; SAF content:// may not open on every device — surface the
  // failure rather than crash. (No-ops silently when sharing is unavailable.)
  const openAttachment = useCallback(async (uri: string): Promise<void> => {
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri);
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] open attachment failed:", reason);
    }
  }, []);

  // Re-enrich only makes sense when the raw input is recoverable from disk.
  // That's photo + shared-image (paired JPEG in Photos/). idea/journal/person
  // notes have no raw input on disk — the enriched body is the only artifact.
  // shared-link/text need a frontmatter migration first (follow-up PR).
  const kind = extractFrontmatterField(body, "kind") ?? "";
  const canReEnrich = kind === "shared-image" || kind === "photo";
  // Transcribe shows for audio notes (both shared-audio + in-app captures
  // use the same kind value). Mutually exclusive with canReEnrich in
  // practice but the disabled guard handles the would-be overlap too.
  const canTranscribe = kind === "shared-audio";
  // Inline player surfaces for the same audio notes the Transcribe button
  // does. Hidden until we have a body (loading guard above) and gated on
  // not-missing (the file has to be on disk).
  const showAudioPlayer = canTranscribe && !missing;

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  // Strip YAML frontmatter so the renderer doesn't show the `---` raw block,
  // then strip paired-binary embeds/links — those render in the Attachments
  // card below (the markdown renderer can't resolve the relative URIs anyway).
  const renderBody = stripPairedBinaryLinks(stripFrontmatter(body));

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

        {transcribeError ? (
          <Banner visible icon="alert" actions={[]}>
            {`Transcribe failed: ${transcribeError}`}
          </Banner>
        ) : null}

        {editError ? (
          <Banner visible icon="alert" actions={[]}>
            {`Save failed: ${editError}`}
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

        {transcribing ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator />
            <Text variant="bodySmall" style={styles.dim}>
              Transcribing audio…
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

        {editMode ? (
          <Card style={styles.card}>
            <Card.Title title="Editing" subtitle="Markdown + frontmatter" />
            <Card.Content>
              <MarkdownToolbar
                onFormat={applyFmt}
                onInsertImage={insertImage}
                disabled={saving}
              />
              <TextInput
                mode="outlined"
                multiline
                numberOfLines={16}
                value={draft}
                onChangeText={(t) => {
                  setDraft(t);
                  // User is typing — stop forcing the caret so the IME owns it.
                  if (forceSelection) setForceSelection(null);
                }}
                selection={forceSelection ?? undefined}
                onSelectionChange={(e) => {
                  setSelection(e.nativeEvent.selection);
                  if (forceSelection) setForceSelection(null);
                }}
                style={styles.editor}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {preview ? (
                <View style={styles.editPreview}>
                  <Markdown style={markdownStyle(theme)}>
                    {stripPairedBinaryLinks(stripFrontmatter(draft))}
                  </Markdown>
                </View>
              ) : null}
            </Card.Content>
            <Card.Actions>
              <Button
                mode="text"
                icon={preview ? "eye-off" : "eye"}
                onPress={() => setPreview((v) => !v)}
              >
                {preview ? "Hide preview" : "Preview"}
              </Button>
              <Button onPress={cancelEdit}>Cancel</Button>
              <Button
                mode="contained"
                onPress={handleSaveEdit}
                disabled={!isDirty}
              >
                Save
              </Button>
            </Card.Actions>
          </Card>
        ) : (
          <>
            {showAudioPlayer ? (
              <Card style={styles.card}>
                <Card.Content>
                  <View style={styles.playerRow}>
                    <IconButton
                      icon={isPlaying ? "pause" : "play"}
                      mode="contained"
                      size={28}
                      onPress={togglePlay}
                      disabled={playerLoading || reEnriching || transcribing}
                      accessibilityLabel={isPlaying ? "Pause" : "Play"}
                    />
                    <View style={styles.playerMeta}>
                      <Text variant="bodySmall" style={styles.playerTime}>
                        {durationMs > 0
                          ? `${formatElapsed(positionMs)} / ${formatElapsed(durationMs)}`
                          : playerLoading
                            ? "Loading…"
                            : "Audio note — tap play"}
                      </Text>
                      <ProgressBar
                        progress={durationMs > 0 ? positionMs / durationMs : 0}
                        style={styles.playerProgress}
                      />
                    </View>
                  </View>
                  {playerError ? (
                    <Text variant="bodySmall" style={styles.playerError}>
                      {`Playback failed: ${playerError}`}
                    </Text>
                  ) : null}
                </Card.Content>
              </Card>
            ) : null}

            {attachments.length > 0 ? (
              <Card style={styles.card}>
                <Card.Title title="Attachments" />
                <Card.Content style={styles.attachmentList}>
                  {attachments.map((a) =>
                    a.mime.startsWith("image/") ? (
                      <Image
                        key={a.rel}
                        source={{ uri: a.uri }}
                        style={styles.attachmentImage}
                        resizeMode="contain"
                        accessibilityLabel={a.filename}
                      />
                    ) : (
                      <Button
                        key={a.rel}
                        mode="outlined"
                        icon="file-document-outline"
                        onPress={() => openAttachment(a.uri)}
                        contentStyle={styles.attachmentFileContent}
                      >
                        {a.filename}
                      </Button>
                    ),
                  )}
                </Card.Content>
              </Card>
            ) : null}

            {!missing ? (
              <Card style={styles.card}>
                <Card.Content>
                  <Markdown style={markdownStyle(theme)}>{renderBody}</Markdown>
                </Card.Content>
              </Card>
            ) : null}

            <Card style={styles.card}>
              <Card.Actions>
                <Button
                  mode="text"
                  icon="pencil"
                  onPress={enterEdit}
                  disabled={missing || reEnriching || transcribing}
                >
                  Edit
                </Button>
                {canReEnrich ? (
                  <Button
                    mode="text"
                    icon="auto-fix"
                    onPress={handleReEnrich}
                    disabled={missing || reEnriching || transcribing}
                  >
                    Re-enrich
                  </Button>
                ) : null}
                {canTranscribe ? (
                  <Button
                    mode="text"
                    icon="text-recognition"
                    onPress={handleTranscribe}
                    disabled={missing || reEnriching || transcribing}
                  >
                    Transcribe
                  </Button>
                ) : null}
                <Button
                  mode="text"
                  icon="delete"
                  textColor={theme.colors.error}
                  onPress={() => setConfirmVisible(true)}
                  disabled={missing || reEnriching || transcribing}
                >
                  Delete
                </Button>
              </Card.Actions>
            </Card>
          </>
        )}
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

        <Dialog visible={discardVisible} onDismiss={keepEditing}>
          <Dialog.Title>Discard changes?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              You have unsaved edits. Discard them and leave?
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={keepEditing}>Keep editing</Button>
            <Button onPress={confirmDiscard} textColor={theme.colors.error}>
              Discard
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
    case "audio":
      return "Audio";
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
  editor: {
    fontFamily: "monospace",
    minHeight: 320,
  },
  editPreview: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#8884",
  },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  playerMeta: { flex: 1, gap: 4 },
  playerTime: { opacity: 0.7, fontVariant: ["tabular-nums"] },
  playerProgress: { height: 4, borderRadius: 2 },
  playerError: { color: "#DC2626", marginTop: 8 },
  attachmentList: { gap: 12 },
  attachmentImage: {
    width: "100%",
    height: 240,
    borderRadius: 8,
    backgroundColor: "#0001",
  },
  attachmentFileContent: { flexDirection: "row-reverse", justifyContent: "flex-end" },
});
