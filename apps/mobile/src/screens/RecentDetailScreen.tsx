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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import * as Sharing from "expo-sharing";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Chip,
  Dialog,
  IconButton,
  type MD3Theme,
  Portal,
  ProgressBar,
  Snackbar,
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
  splitFrontmatter,
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
import {
  getFrontmatterTags,
  parseFrontmatter,
  upsertFrontmatterField,
} from "../lib/frontmatter";
import {
  attachTags,
  createTextBookmark,
  updateTextBookmark,
  KarakeepError,
} from "../lib/karakeep";
import { pushNoteAttachments } from "../lib/karakeepExport";
import { rewriteImageEmbedsToAssetUrls } from "../lib/karakeepInlineImages";
import { clearPushedAssets } from "../lib/karakeepAssetSync";
import { pickAttachment } from "../lib/attachments";
import { MAX_EDITOR_IMAGE_BASE64, toDataUri } from "../lib/editorImages";
import { MarkdownToolbar } from "../components/MarkdownToolbar";
import { makeImageRule } from "../components/markdownImageRule";
import { WysiwygEditor, type WysiwygEditorRef } from "../components/WysiwygEditor";
import { TagInput } from "../components/TagInput";
import { applyTagsToHeader } from "../lib/tags";
import { getTagIndex, invalidateNoteIndex, tagsForNote } from "../lib/vault";
import { enrichSharedImage, transcribeAudio } from "../lib/omniroute";
import {
  removeFromHistory,
  removeFromHistoryByFilepath,
  updateCaptureTitle,
  type CaptureEntry,
} from "../lib/storage";
import { getSettings } from "../lib/settings";

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
    try {
      const { header, body: noteBody } = splitFrontmatter(body);
      // Title: note H1 → filename stem fallback. deriveTitle falls back to the
      // first line / "Untitled", so guard against an empty/whitespace H1 too.
      const stem =
        entry.filepath
          .split("/")
          .pop()
          ?.replace(/\.md$/i, "") ?? entry.title;
      const title = deriveTitle(noteBody).trim() || stem;
      // Tags: frontmatter tags + a `kind` tag (idea/journal/person/...), deduped.
      const fmTags = getFrontmatterTags(body);
      const kindField = parseFrontmatter(body).fields.find(
        ([k]) => k === "kind",
      );
      const kindTag = kindField?.[1]?.trim() ?? "";
      const tags = [...new Set([...fmTags, ...(kindTag ? [kindTag] : [])])];
      const createdAt = extractFrontmatterField(body, "created") ?? undefined;

      const existingId = extractFrontmatterField(body, "karakeepId");
      let id: string;
      let didUpdate = false;
      if (existingId) {
        try {
          ({ id } = await updateTextBookmark(existingId, {
            text: noteBody,
            title,
            createdAt,
          }));
          didUpdate = true;
        } catch (e: unknown) {
          // The stored id points at a bookmark that no longer exists on the
          // server — recover by creating a fresh one and re-stamping the id.
          // ACCEPTED LIMITATION: a 404 from a *misconfigured* base URL (e.g. the
          // user repointed karakeepUrl at a host without /api/v1) is
          // indistinguishable here from a deleted bookmark, so it would create a
          // duplicate. Bounded (one recoverable bookmark, requires misconfig);
          // disambiguating would need a confirming GET — out of scope for v2.
          if (e instanceof KarakeepError && e.status === 404) {
            ({ id } = await createTextBookmark({ text: noteBody, title, createdAt }));
            // The old bookmark is gone; its asset-sync record is dead. Drop it so
            // AsyncStorage doesn't accumulate orphans, and so the fresh bookmark's
            // (empty) record drives a full re-push of attachments below.
            void clearPushedAssets(existingId);
          } else {
            throw e;
          }
        }
      } else {
        ({ id } = await createTextBookmark({ text: noteBody, title, createdAt }));
      }
      // attachTags is additive — on an update it re-attaches the note's current
      // tags but does NOT detach tags removed from the note since the first
      // export. ACCEPTED LIMITATION: the bookmark's tag set can drift superset;
      // detaching would need a GET-diff + DELETE pass (a later increment).
      await attachTags(id, tags);

      // Incrementally sync attachments on BOTH create and re-export. A
      // per-bookmark sync record (keyed by bookmark id, in AsyncStorage) means
      // already-attached files are skipped — so Karakeep never accumulates
      // duplicates on re-send — while an attachment added after the first export,
      // or one that failed earlier, is (re)pushed here. Returns the first error
      // (or null); a partial failure still leaves the bookmark stamped below.
      const { error: assetError, imageUrlByRel } = await pushNoteAttachments(
        id,
        noteBody,
      );

      // Inline the note's images into the Karakeep bookmark BODY: rewrite each
      // ../Photos embed to its uploaded asset URL so the images render in-content
      // (Karakeep's MarkdownReadonly renders `![](…)` unrestricted — verified
      // against a live instance). The VAULT note keeps its relative links — only
      // this Karakeep copy is inlined. Best-effort: the bookmark already holds the
      // original text + attached assets (incl. the cover), so a failed inline
      // PATCH never loses the export.
      const inlinedBody = rewriteImageEmbedsToAssetUrls(noteBody, imageUrlByRel);
      if (inlinedBody !== noteBody) {
        try {
          await updateTextBookmark(id, { text: inlinedBody, title, createdAt });
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn(
            "[RecentDetail] Karakeep inline-image body update failed:",
            reason,
          );
        }
      }

      // Idempotency: stamp the bookmark id into the note frontmatter (a no-op
      // rewrite on update, since the id is unchanged). Stamped even when an
      // attachment failed — the bookmark exists, so a re-export should update it
      // rather than create a second one.
      const next = upsertFrontmatterField(header + noteBody, "karakeepId", id);
      await updateNote(entry.filepath, next);
      if (!mountedRef.current) return;
      setBody(next);
      if (assetError) {
        setKarakeepError(
          `Exported to Karakeep, but an attachment failed: ${assetError}`,
        );
      } else {
        setKarakeepUpdated(didUpdate);
        setKarakeepDone(true);
      }
    } catch (e: unknown) {
      const reason =
        e instanceof KarakeepError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      console.warn("[RecentDetail] Karakeep export failed:", reason);
      if (mountedRef.current) setKarakeepError(reason);
    } finally {
      exportingKarakeepRef.current = false;
      if (mountedRef.current) setExportingKarakeep(false);
    }
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
      const rel = `../Photos/${finalName}`;
      const dataUri =
        picked.base64.length <= MAX_EDITOR_IMAGE_BASE64
          ? toDataUri(picked.mime, picked.base64)
          : null;
      wysiwygRef.current?.insertImage(rel, dataUri);
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
      // Reattach the stashed frontmatter, applying any tag edits. Unchanged tags
      // keep the header byte-exact (no spurious frontmatter rewrite).
      const header = applyTagsToHeader(
        editHeaderRef.current,
        editTags,
        editOriginalTagsRef.current,
      );
      // applyTagsToHeader returns the header verbatim when the tag set is
      // unchanged, so a differing header means the tags changed.
      const tagsChanged = header !== editHeaderRef.current;
      next = header + editedBody;
      if (next === body) {
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
    () => ({ image: makeImageRule(imageUriByRel, styles.inlineImage) }),
    [imageUriByRel],
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
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
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

        {karakeepError ? (
          <Banner visible icon="alert" actions={[]}>
            {`Karakeep export failed: ${karakeepError}`}
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

        {exportingKarakeep ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator />
            <Text variant="bodySmall" style={styles.dim}>
              Sending to Karakeep…
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
            {noteLocation ? (
              <View style={styles.metaRow}>
                <Chip
                  icon="map-marker"
                  compact
                  onPress={() =>
                    void Linking.openURL(`geo:${noteLocation}?q=${noteLocation}`).catch(
                      () => undefined,
                    )
                  }
                >
                  {noteLocation}
                </Chip>
              </View>
            ) : null}
          </Card.Content>
        </Card>

        {editMode ? (
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
                  <View style={styles.editPreview}>
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

            {!missing ? (
              <Card style={styles.card}>
                <Card.Content>
                  <Markdown style={markdownStyle(theme)} rules={markdownRules}>
                    {renderBody}
                  </Markdown>
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
                {karakeepConfigured ? (
                  <Button
                    mode="text"
                    icon="bookmark-plus-outline"
                    onPress={handleSendToKarakeep}
                    disabled={
                      missing ||
                      reEnriching ||
                      transcribing ||
                      exportingKarakeep
                    }
                  >
                    Send to Karakeep
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

      <Snackbar
        visible={karakeepDone}
        onDismiss={() => setKarakeepDone(false)}
        duration={2500}
      >
        {karakeepUpdated ? "Updated in Karakeep" : "Exported to Karakeep"}
      </Snackbar>

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
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
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
  // Inline image rendered in the note prose via makeImageRule. Same sizing as
  // the (now files-only) attachment image, with vertical rhythm so it sits as
  // its own block between paragraphs.
  inlineImage: {
    width: "100%",
    height: 240,
    borderRadius: 8,
    backgroundColor: "#0001",
    marginVertical: 8,
  },
  attachmentFileContent: { flexDirection: "row-reverse", justifyContent: "flex-end" },
});
