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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Sharing from "expo-sharing";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Dialog,
  FAB,
  IconButton,
  List,
  type MD3Theme,
  Modal,
  Portal,
  ProgressBar,
  Snackbar,
  Text,
  TextInput,
} from "react-native-paper";
import Markdown from "react-native-markdown-display";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import { deriveTitle } from "@carnet/shared";
import { formatElapsed } from "../lib/shareHelpers";

import type { RootStackParamList } from "../../App";
import {
  extractFrontmatterField,
  listPairedBinaries,
  moveToArchive,
  readNote,
  readPairedBinaryUri,
  resolvePairedUri,
  splitFrontmatter,
  stripFrontmatter,
  stripPairedBinaryLinks,
  updateNote,
} from "../lib/writer";
import {
  applyFormat,
  insertAtCursor,
  type FormatKind,
  type Sel,
} from "../lib/markdownEdit";
import { MarkdownToolbar } from "../components/MarkdownToolbar";
import { StampChip } from "../components/StampChip";
import { modeStamp } from "../components/NoteCard";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { makeImageRule } from "../components/markdownImageRule";
import { WysiwygEditor, type WysiwygEditorRef } from "../components/WysiwygEditor";
import { TagInput } from "../components/TagInput";
import { getTagIndex, invalidateNoteIndex, tagsForNote } from "../lib/vault";
import { exportNoteToKarakeep } from "../lib/karakeepNoteExport";
import { reEnrichNote, transcribeNote } from "../lib/noteReprocess";
import { planWysiwygSave } from "../lib/wysiwygSave";
import { pickAndWriteVaultImage } from "../lib/vaultImageInsert";
import {
  removeFromHistory,
  removeFromHistoryByFilepath,
  updateCaptureTitle,
  type CaptureEntry,
} from "../lib/storage";
import { getSettings } from "../lib/settings";

type Props = NativeStackScreenProps<RootStackParamList, "RecentDetail">;

export default function RecentDetailScreen({ route, navigation }: Props) {
  const theme = useCarnetTheme();
  const { entry } = route.params;

  const [body, setBody] = useState<string>("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmVisible, setConfirmVisible] = useState(false);
  // Secondary actions live in a bottom sheet behind the header overflow;
  // the raw file path lives in a "File info" dialog off that sheet. Edit is
  // the screen's single primary action (the FAB).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [fileInfoOpen, setFileInfoOpen] = useState(false);
  const [reEnriching, setReEnriching] = useState(false);
  const [reEnrichError, setReEnrichError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  // Karakeep export. The action is gated on a non-blank `karakeepUrl`, read
  // once on mount like richEditorEnabled. `karakeepError` surfaces a failure as
  // a banner; `karakeepDone` flips a success snackbar.
  const [karakeepConfigured, setKarakeepConfigured] = useState(false);
  const [exportingKarakeep, setExportingKarakeep] = useState(false);
  const [karakeepError, setKarakeepError] = useState<string | null>(null);
  const [karakeepDone, setKarakeepDone] = useState(false);
  // True when the last successful export UPDATED an existing bookmark (vs
  // created a new one) — drives the success-snackbar copy.
  const [karakeepUpdated, setKarakeepUpdated] = useState(false);
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
  // Rich (WYSIWYG / TenTap) editor — now the default note editor (the
  // experimental Settings toggle was removed). Edit mode mounts WysiwygEditor
  // over the note BODY only: frontmatter is split off on enter and reattached
  // byte-exact on save, so the editor never sees or rewrites the `---` block.
  // Still backed by `richEditorEnabled` (default true) so it stays easy to gate
  // again later; the markdown TextInput path remains as the false branch.
  const [richEditorEnabled, setRichEditorEnabled] = useState(true);
  const [wysiwygSeed, setWysiwygSeed] = useState<string>("");
  const wysiwygRef = useRef<WysiwygEditorRef>(null);
  const editHeaderRef = useRef<string>("");
  // Tag editing (rich edit mode). `editTags` is the live chip set; the ref holds
  // the tags as they were on entering edit so save can skip rewriting the
  // frontmatter byte-exact when the set is unchanged. `knownTags` backs autocomplete.
  const [editTags, setEditTags] = useState<string[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const editOriginalTagsRef = useRef<string[]>([]);
  const insertingImageRef = useRef(false);
  // Guard against fast double-taps on Delete — the in-flight archive can
  // race with a second handler call and produce a confusing UI state.
  const deletingRef = useRef(false);
  // Same guard for the Re-enrich button — re-running the LLM call twice
  // would write the .md twice, with whichever finishes second winning.
  const reEnrichingRef = useRef(false);
  const transcribingRef = useRef(false);
  const exportingKarakeepRef = useRef(false);
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

  // Header overflow (⋮) — the entry to the secondary-actions sheet. Hidden
  // while editing (the edit surface has its own Save/Cancel chrome).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: editMode
        ? undefined
        : () => (
            <IconButton
              icon="dots-vertical"
              onPress={() => setActionsOpen(true)}
              accessibilityLabel="More actions"
            />
          ),
    });
  }, [navigation, editMode]);

  // Reconcile with the persisted setting once on mount (default true). Kept so a
  // future gate can flip it off again without re-plumbing the screen.
  useEffect(() => {
    let active = true;
    getSettings()
      .then((s) => {
        if (!active) return;
        setRichEditorEnabled(s.richEditorEnabled);
        // Gate the "Send to Karakeep" action on a configured instance URL.
        setKarakeepConfigured(s.karakeepUrl.trim().length > 0);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Load the vault tag index for edit-mode autocomplete (cache-first; best-effort).
  useEffect(() => {
    let active = true;
    getTagIndex()
      .then((index) => {
        if (active) setKnownTags(index.tags.map((e) => e.tag));
      })
      .catch(() => undefined);
    return () => {
      active = false;
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
      // Remove by id (recents-opened) AND by filepath (tag-browser-opened notes
      // carry a synthesized id that won't match) so no ghost row survives.
      await removeFromHistory(entry.id);
      await removeFromHistoryByFilepath(entry.filepath);
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
    const outcome = await reEnrichNote({ body, filepath: entry.filepath });
    if (outcome.kind === "updated") setBody(outcome.nextBody);
    else setReEnrichError(outcome.reason);
    reEnrichingRef.current = false;
    setReEnriching(false);
  }, [body, entry.filepath]);

  const handleTranscribe = useCallback(async () => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    setTranscribeError(null);
    setTranscribing(true);
    const outcome = await transcribeNote({ body, filepath: entry.filepath });
    if (outcome.kind === "updated") setBody(outcome.nextBody);
    else setTranscribeError(outcome.reason);
    transcribingRef.current = false;
    setTranscribing(false);
  }, [body, entry.filepath]);

  // Export the note to Karakeep as a text bookmark. Mirrors the other async
  // actions' guards (in-flight ref, mounted ref, error banner). The note's
  // full markdown is split: the frontmatter header drives the tags + createdAt,
  // the body becomes the bookmark text. Tags = frontmatter tags + a `kind` tag.
  // When the note already carries a `karakeepId`, the existing bookmark is
  // UPDATED in place (PATCH) rather than duplicated; if that id was deleted
  // server-side (404) we fall back to creating a fresh one. The resulting
  // bookmark id is (re)written into the note frontmatter for idempotency.
  const runKarakeepExport = useCallback(async () => {
    if (exportingKarakeepRef.current) return;
    exportingKarakeepRef.current = true;
    setKarakeepError(null);
    setExportingKarakeep(true);
    // exportNoteToKarakeep owns the create-vs-update / 404-recovery / asset-sync
    // orchestration + the in-place note write; the screen only translates the
    // outcome into UI state (guarded by mountedRef so a Back-during-export can't
    // setState after unmount — the disk write itself already landed).
    const outcome = await exportNoteToKarakeep({
      body,
      filepath: entry.filepath,
      entryTitle: entry.title,
    });
    if (mountedRef.current) {
      if (outcome.kind === "failed") {
        setKarakeepError(outcome.reason);
      } else {
        setBody(outcome.nextBody);
        if (outcome.kind === "partial") {
          setKarakeepError(
            `Exported to Karakeep, but an attachment failed: ${outcome.assetError}`,
          );
        } else {
          setKarakeepUpdated(outcome.didUpdate);
          setKarakeepDone(true);
        }
      }
    }
    exportingKarakeepRef.current = false;
    if (mountedRef.current) setExportingKarakeep(false);
  }, [body, entry.filepath, entry.title]);

  // Entry point for the button. If the note was already exported (frontmatter
  // carries a karakeepId), confirm before re-sending; otherwise export directly.
  const handleSendToKarakeep = useCallback(() => {
    if (exportingKarakeepRef.current) return;
    const alreadyExported = extractFrontmatterField(body, "karakeepId");
    if (alreadyExported) {
      Alert.alert(
        "Already exported",
        "This note is already in Karakeep. Update the existing bookmark with the current text and tags?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Update", onPress: () => void runKarakeepExport() },
        ],
      );
      return;
    }
    void runKarakeepExport();
  }, [body, runKarakeepExport]);

  // True iff the user is in edit mode AND has typed something different
  // from the on-disk body. Drives the beforeRemove guard + Cancel button's
  // decision to skip the discard dialog when there's nothing to discard.
  // The WYSIWYG editor holds its content inside the WebView; diffing it per
  // keystroke would cost a bridge round-trip each time, so we conservatively
  // treat any rich-editor session as dirty — the discard prompt may appear with
  // no real change, but edits are never silently lost.
  const isDirty = editMode && (richEditorEnabled ? true : draft !== body);

  const enterEdit = useCallback(() => {
    setEditError(null);
    if (richEditorEnabled) {
      // Split frontmatter off and stash it; the editor only ever sees the body,
      // and the header is reattached byte-exact on save (splitFrontmatter docs).
      const { header, body: noteBody } = splitFrontmatter(body);
      editHeaderRef.current = header;
      setWysiwygSeed(noteBody);
      // Seed the tag chips from the note's frontmatter (distinct + normalized).
      const noteTags = tagsForNote(body);
      editOriginalTagsRef.current = noteTags;
      setEditTags(noteTags);
    } else {
      setDraft(body);
      setSelection({ start: 0, end: 0 });
      setForceSelection(null);
      setPreview(false);
    }
    setEditMode(true);
  }, [body, richEditorEnabled]);

  const exitEdit = useCallback(() => {
    setEditMode(false);
    setDraft("");
    setEditError(null);
    setForceSelection(null);
    setPreview(false);
    setEditTags([]);
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
      const written = await pickAndWriteVaultImage();
      if (!written) return;
      const r = insertAtCursor(draft, selection, `![](${written.rel})`);
      setDraft(r.text);
      setSelection(r.selection);
      setForceSelection(r.selection);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      insertingImageRef.current = false;
    }
  }, [draft, selection]);

  /** Rich-editor image button: pick → write to the vault → insert the embed at
   * the cursor inside the WYSIWYG editor. The picked bytes are reused to build
   * the in-editor data-URI preview (no disk re-read); an image over the inline
   * cap still inserts + saves, just without an in-editor preview. Cancelling
   * writes nothing; discarding the edit after inserting leaves the file orphaned
   * in Photos/ (recoverable in the vault, same as a stub photo). */
  const insertWysiwygImage = useCallback(async () => {
    if (insertingImageRef.current || savingEditRef.current) return;
    insertingImageRef.current = true;
    setEditError(null);
    try {
      const written = await pickAndWriteVaultImage();
      if (!written) return;
      wysiwygRef.current?.insertImage(written.rel, written.dataUri);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      insertingImageRef.current = false;
    }
  }, []);

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

  // WYSIWYG save: pull the edited body back out of the WebView as markdown, then
  // reattach the stashed frontmatter header byte-exact. Mirrors handleSaveEdit's
  // disk-then-title flow and its guards (in-flight ref, mounted ref, banner).
  const handleSaveWysiwyg = useCallback(async () => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSaving(true);
    setEditError(null);
    let next: string;
    try {
      // getMarkdown() rejects on its own 5s timeout (awaitMarkdownResponse), so a
      // never-resolving bridge — Save tapped before the editor mounted — surfaces
      // as an error instead of a stuck, disabled UI, and never leaks the resolver.
      const editedBody = await (wysiwygRef.current?.getMarkdown() ??
        Promise.reject(new Error("Editor not mounted")));
      // Reattach the stashed frontmatter (applying tag edits) and decide whether
      // a write is even needed — planWysiwygSave keeps the header byte-exact when
      // tags are unchanged and skips the write when the content is identical.
      const plan = planWysiwygSave({
        header: editHeaderRef.current,
        editedBody,
        editTags,
        originalTags: editOriginalTagsRef.current,
        currentBody: body,
      });
      const tagsChanged = plan.tagsChanged;
      next = plan.next;
      if (!plan.shouldWrite) {
        // Editor returned the exact on-disk content — nothing changed. Skip the
        // write so opening + saving a note never churns its content/mtime. (Real
        // edits, and any whitespace/underscore-escape normalization, still differ
        // and do write.)
        if (mountedRef.current) {
          setEditMode(false);
          setSaving(false);
        }
        savingEditRef.current = false;
        return;
      }
      await updateNote(entry.filepath, next);
      if (!mountedRef.current) {
        savingEditRef.current = false;
        return;
      }
      setBody(next);
      // A tag change makes the vault index stale — drop the cache so the
      // browser counts + capture autocomplete rebuild on next read.
      if (tagsChanged) void invalidateNoteIndex().catch(() => undefined);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] save (rich) failed:", reason);
      if (mountedRef.current) {
        setEditError(reason);
        setSaving(false);
      }
      savingEditRef.current = false;
      return;
    }

    // Best-effort recents-title refresh, same as the markdown path.
    const newTitle = deriveTitle(next) || entry.title;
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
      setSaving(false);
    }
    savingEditRef.current = false;
  }, [body, editTags, entry.filepath, entry.id, entry.title]);

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

  // Map each resolved IMAGE embed's relative link (`../Photos/x.jpg`) to its
  // device URI so the markdown renderer can draw it inline (see makeImageRule).
  // Non-image files stay out — they render as tappable rows in the card below.
  const imageUriByRel = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attachments) {
      if (a.mime.startsWith("image/")) m.set(a.rel, a.uri);
    }
    return m;
  }, [attachments]);
  const markdownRules = useMemo(
    () => ({
      image: makeImageRule(imageUriByRel, [
        styles.inlineImage,
        { backgroundColor: theme.colors.surfaceVariant },
      ]),
    }),
    [imageUriByRel, theme.colors.surfaceVariant],
  );

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
    // Skeleton paragraph blocks — reads as "content coming", not a spinner.
    return (
      <View
        style={[
          styles.loading,
          {
            backgroundColor: theme.colors.background,
            padding: theme.carnet.spacing.lg,
            gap: theme.carnet.spacing.md,
          },
        ]}
      >
        {[64, 16, 16, 16].map((h, i) => (
          <View
            key={i}
            style={{
              height: h,
              width: i === 0 ? "60%" : "100%",
              backgroundColor: theme.colors.surfaceVariant,
              borderRadius: theme.carnet.radius.sm,
            }}
          />
        ))}
      </View>
    );
  }

  // Strip YAML frontmatter so the renderer doesn't show the `---` raw block,
  // then strip only Audio + non-image File links (rendered by the player /
  // files card). Image embeds STAY so they render inline in the prose via the
  // custom markdown image rule (markdownRules). Non-image files render as
  // tappable rows in the card below.
  const renderBody = stripPairedBinaryLinks(stripFrontmatter(body), {
    keepImages: true,
  });
  const fileAttachments = attachments.filter(
    (a) => !a.mime.startsWith("image/"),
  );
  const noteLocation = extractFrontmatterField(body, "location");
  const noteTags = tagsForNote(body);
  const pendingEnrich = extractFrontmatterField(body, "status") === "pending-enrich";
  // One banner slot: a failed save is the most actionable, then the export/
  // operation errors. (The missing-file case takes over the whole screen.)
  const activeIssue = editError
    ? `Save failed: ${editError}`
    : karakeepError
      ? `Karakeep export failed: ${karakeepError}`
      : transcribeError
        ? `Transcribe failed: ${transcribeError}`
        : reEnrichError
          ? `Re-enrich failed: ${reEnrichError}`
          : null;
  const busyLabel = reEnriching
    ? "Re-running vision enrichment…"
    : transcribing
      ? "Transcribing audio…"
      : exportingKarakeep
        ? "Sending to Karakeep…"
        : null;
  const actionsBusy = reEnriching || transcribing || exportingKarakeep;

  // Rich (WYSIWYG) editing takes the whole screen so TenTap's formatting toolbar
  // can dock above the keyboard. Frontmatter is split off and reattached on save,
  // so the editor only shows the body — the path/attachments cards aren't needed
  // here, and the scrolling card layout would trap the toolbar in a small box.
  if (editMode && richEditorEnabled) {
    return (
      <View style={[styles.richRoot, { backgroundColor: theme.colors.background }]}>
        {editError ? (
          <Banner visible icon="alert" actions={[]}>
            {`Save failed: ${editError}`}
          </Banner>
        ) : null}
        <View
          style={[
            styles.richBar,
            { borderBottomColor: theme.colors.outlineVariant },
          ]}
        >
          <Text variant="titleMedium">Editing · Rich text</Text>
          <View style={styles.richBarActions}>
            <IconButton
              icon="image-plus"
              size={22}
              onPress={insertWysiwygImage}
              disabled={saving}
              accessibilityLabel="Insert image"
            />
            <Button onPress={cancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button
              mode="contained"
              onPress={handleSaveWysiwyg}
              loading={saving}
              disabled={saving}
            >
              Save
            </Button>
          </View>
        </View>
        <View style={styles.richTags}>
          <TagInput tags={editTags} onChange={setEditTags} knownTags={knownTags} />
        </View>
        <View style={styles.richEditor}>
          <WysiwygEditor ref={wysiwygRef} value={wysiwygSeed} />
        </View>
        <Portal>
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
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        {missing ? (
          // Dedicated missing-file state — nothing else renders over it.
          <View style={[styles.missingWrap, { gap: theme.carnet.spacing.md }]}>
            <IconButton icon="file-question-outline" size={48} />
            <Text variant="titleMedium">Note not found</Text>
            <Text
              variant="bodyMedium"
              style={[styles.missingText, { color: theme.colors.onSurfaceVariant }]}
            >
              This note was moved or deleted outside carnet — probably in
              Obsidian. Its history entry can be removed safely.
            </Text>
            <Button mode="contained-tonal" onPress={handleRemoveFromHistory}>
              Remove from list
            </Button>
          </View>
        ) : null}

        {/* One banner slot — the most actionable issue wins instead of five
            banners stacking above the note. */}
        {!missing && activeIssue ? (
          <Banner visible icon="alert" actions={[]}>
            {activeIssue}
          </Banner>
        ) : null}

        {!missing && busyLabel ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator />
            <Text variant="bodySmall" style={styles.dim}>
              {busyLabel}
            </Text>
          </View>
        ) : null}

        {/* Metadata as one quiet stamp row — the reading surface starts
            immediately below. The raw file path lives in File info. */}
        {!missing && !editMode ? (
          <View style={[styles.metaRow, { gap: theme.carnet.spacing.sm }]}>
            <StampChip
              label={modeStamp(entry.mode).label}
              icon={modeStamp(entry.mode).icon}
            />
            {noteTags.map((tag) => (
              <Pressable
                key={tag}
                style={styles.stampHit}
                onPress={() => navigation.navigate("Search", { tag })}
                accessibilityRole="button"
                accessibilityLabel={`Search notes tagged ${tag}`}
              >
                <StampChip label={`#${tag}`} />
              </Pressable>
            ))}
            {noteLocation ? (
              <Pressable
                style={styles.stampHit}
                onPress={() =>
                  void Linking.openURL(`geo:${noteLocation}?q=${noteLocation}`).catch(
                    () => undefined,
                  )
                }
                accessibilityRole="button"
                accessibilityLabel="Open location in maps"
              >
                <StampChip label="location" icon="map-marker" />
              </Pressable>
            ) : null}
            {pendingEnrich ? (
              <StampChip label="pending" icon="sync" tone="stamp" />
            ) : null}
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {formatDate(entry.createdAt)}
            </Text>
          </View>
        ) : null}

        {!missing && editMode ? (
          <Card style={styles.card}>
            {/* Reached only in markdown mode: the rich (WYSIWYG) editor renders
                full-screen via the early return near the top of render(). */}
            <Card.Title title="Editing" subtitle="Markdown + frontmatter" />
            <Card.Content>
              <>
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
                  <View
                    style={[
                      styles.editPreview,
                      { borderTopColor: theme.colors.outlineVariant },
                    ]}
                  >
                    <Markdown style={markdownStyle(theme)}>
                      {stripPairedBinaryLinks(stripFrontmatter(draft))}
                    </Markdown>
                  </View>
                ) : null}
              </>
            </Card.Content>
            <Card.Actions>
              {!richEditorEnabled ? (
                <Button
                  mode="text"
                  icon={preview ? "eye-off" : "eye"}
                  onPress={() => setPreview((v) => !v)}
                >
                  {preview ? "Hide preview" : "Preview"}
                </Button>
              ) : null}
              <Button onPress={cancelEdit}>Cancel</Button>
              <Button
                mode="contained"
                onPress={richEditorEnabled ? handleSaveWysiwyg : handleSaveEdit}
                disabled={!isDirty}
              >
                Save
              </Button>
            </Card.Actions>
          </Card>
        ) : !missing ? (
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
                    <Text
                      variant="bodySmall"
                      style={[styles.playerError, { color: theme.colors.error }]}
                    >
                      {`Playback failed: ${playerError}`}
                    </Text>
                  ) : null}
                </Card.Content>
              </Card>
            ) : null}

            {/* Images now render inline in the note body (below); only
                non-image files surface here as tappable rows. */}
            {fileAttachments.length > 0 ? (
              <Card style={styles.card}>
                <Card.Title title="Attachments" />
                <Card.Content style={styles.attachmentList}>
                  {fileAttachments.map((a) => (
                    <Button
                      key={a.rel}
                      mode="outlined"
                      icon="file-document-outline"
                      onPress={() => openAttachment(a.uri)}
                      contentStyle={styles.attachmentFileContent}
                    >
                      {a.filename}
                    </Button>
                  ))}
                </Card.Content>
              </Card>
            ) : null}

            {/* The note itself — full-width on the reading surface, no card
                box. This is what the user came for; it starts here. */}
            <View style={styles.bodyWrap}>
              <Markdown style={markdownStyle(theme)} rules={markdownRules}>
                {renderBody}
              </Markdown>
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Single primary action: edit. Everything else is behind the header
          overflow sheet. */}
      {!missing && !editMode ? (
        <FAB
          icon="pencil"
          label="Edit"
          color={theme.carnet.onFill}
          style={[
            styles.fab,
            {
              backgroundColor: theme.carnet.fill,
              borderRadius: theme.carnet.radius.pill,
            },
          ]}
          onPress={enterEdit}
          disabled={actionsBusy}
          accessibilityLabel="Edit note"
        />
      ) : null}

      <Snackbar
        visible={karakeepDone}
        onDismiss={() => setKarakeepDone(false)}
        duration={2500}
      >
        {karakeepUpdated ? "Updated in Karakeep" : "Exported to Karakeep"}
      </Snackbar>

      <Portal>
        {/* Secondary actions sheet (header ⋮). Delete sits last, stamp-red,
            separated from the rest. */}
        <Modal
          visible={actionsOpen}
          onDismiss={() => setActionsOpen(false)}
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
          {canReEnrich ? (
            <List.Item
              title="Re-enrich"
              description="Re-run AI enrichment on the original image"
              left={(p) => <List.Icon {...p} icon="auto-fix" />}
              disabled={actionsBusy}
              onPress={() => {
                setActionsOpen(false);
                void handleReEnrich();
              }}
              style={styles.sheetRow}
            />
          ) : null}
          {canTranscribe ? (
            <List.Item
              title="Transcribe"
              description="Turn the audio into a text transcript"
              left={(p) => <List.Icon {...p} icon="text-recognition" />}
              disabled={actionsBusy}
              onPress={() => {
                setActionsOpen(false);
                void handleTranscribe();
              }}
              style={styles.sheetRow}
            />
          ) : null}
          {karakeepConfigured ? (
            <List.Item
              title="Send to Karakeep"
              description="Bookmark this note on your Karakeep instance"
              left={(p) => <List.Icon {...p} icon="bookmark-plus-outline" />}
              disabled={actionsBusy || missing}
              onPress={() => {
                setActionsOpen(false);
                handleSendToKarakeep();
              }}
              style={styles.sheetRow}
            />
          ) : null}
          <List.Item
            title="File info"
            description="Where this note lives in the vault"
            left={(p) => <List.Icon {...p} icon="file-document-outline" />}
            onPress={() => {
              setActionsOpen(false);
              setFileInfoOpen(true);
            }}
            style={styles.sheetRow}
          />
          <View
            style={[styles.sheetDivider, { backgroundColor: theme.colors.outline }]}
          />
          <List.Item
            title="Delete"
            description="Move the note to Archive/"
            titleStyle={{ color: theme.colors.error }}
            left={(p) => (
              <List.Icon {...p} icon="delete" color={theme.colors.error} />
            )}
            disabled={actionsBusy || missing}
            onPress={() => {
              setActionsOpen(false);
              setConfirmVisible(true);
            }}
            style={styles.sheetRow}
          />
        </Modal>

        <Dialog
          visible={fileInfoOpen}
          onDismiss={() => setFileInfoOpen(false)}
          style={{ borderRadius: theme.carnet.radius.sheet }}
        >
          <Dialog.Title>File info</Dialog.Title>
          <Dialog.Content style={{ gap: theme.carnet.spacing.sm }}>
            <Text variant="bodySmall" selectable style={styles.path}>
              {entry.filepath}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {`${formatMode(entry.mode)} · captured ${formatDate(entry.createdAt)}`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setFileInfoOpen(false)}>Close</Button>
          </Dialog.Actions>
        </Dialog>

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
  content: { padding: 16, gap: 12, paddingBottom: 96 },
  card: { marginTop: 4 },
  path: { opacity: 0.6, fontFamily: "monospace" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  stampHit: { minHeight: MIN_TAP_TARGET, justifyContent: "center" },
  bodyWrap: { paddingTop: 4 },
  missingWrap: { alignItems: "center", paddingVertical: 48 },
  missingText: { textAlign: "center" },
  fab: { position: "absolute", right: 16, bottom: 24 },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderWidth: 1 },
  sheetRow: { minHeight: MIN_TAP_TARGET },
  sheetDivider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  dim: { opacity: 0.6 },
  loading: { flex: 1 },
  inlineLoading: {
    paddingVertical: 16,
    alignItems: "center",
    gap: 6,
  },
  editor: {
    fontFamily: "monospace",
    minHeight: 320,
  },
  // Full-screen rich-edit layout. The toolbar docks at the top of the editor
  // (Android edge-to-edge can't lift it above the keyboard — see WysiwygEditor).
  richRoot: { flex: 1 },
  richBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  richBarActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  richTags: { paddingHorizontal: 16, paddingBottom: 4 },
  richEditor: { flex: 1 },
  // borderTopColor comes from the theme at the usage site (outlineVariant).
  editPreview: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  playerMeta: { flex: 1, gap: 4 },
  playerTime: { opacity: 0.7, fontVariant: ["tabular-nums"] },
  playerProgress: { height: 4, borderRadius: 2 },
  // color comes from the theme at the usage site (colors.error).
  playerError: { marginTop: 8 },
  attachmentList: { gap: 12 },
  // Inline image rendered in the note prose via makeImageRule; background
  // tint comes from the theme at the usage site (surfaceVariant).
  inlineImage: {
    width: "100%",
    height: 240,
    borderRadius: 12,
    marginVertical: 8,
  },
  attachmentFileContent: { flexDirection: "row-reverse", justifyContent: "flex-end" },
});
