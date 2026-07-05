import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Chip,
  HelperText,
  Text,
  TextInput,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
// Non-crypto local ID — only used as a key for the recents history list,
// not for anything security-sensitive. uuid v11 requires crypto.getRandomValues
// which RN doesn't provide without the react-native-get-random-values polyfill
// (which would require a native rebuild). This avoids that whole detour.
const localId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

import type { RootStackParamList } from "../../App";
import { VoiceButton, type VoiceButtonHandle } from "../voice/VoiceButton";
import { CardScannerModal } from "../components/CardScannerModal";
import { TagInput } from "../components/TagInput";
import { LocationChip } from "../components/LocationChip";
import { getSettings } from "../lib/settings";
import { recordCapture, type CaptureMode } from "../lib/storage";
import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  isPermanentError,
  isNotConfiguredError,
  promoteIdea as omniPromoteIdea,
} from "../lib/omniroute";
import {
  slugify,
  writeIdea,
  appendJournal,
  writePerson,
  writeBinary,
  injectAttachments,
  extFromMime,
  readNote,
  updateNoteIfUnchanged,
  getModificationTime,
  rewriteFrontmatterField,
  extractNameFromMarkdown,
  type AttachmentRef,
} from "../lib/writer";
import {
  enrichIdeaInPlace,
  writeRawIdea,
  type EnrichIdeaOutcome,
  type RawIdeaInput,
} from "../lib/ideaSaveFirst";
import { pickAttachment, type PickedAttachment } from "../lib/attachments";
import { enqueue, drainQueue, getQueueDepth } from "../lib/queue";
import { mergeUserTags } from "../lib/tags";
import { upsertFrontmatterField } from "../lib/frontmatter";
import { getTagIndex, invalidateTagIndex } from "../lib/vault";
import {
  IDEA_STATUSES,
  deriveTitle,
  parseStatusFromMarkdown,
  type CaptureResponse,
  type IdeaStatus,
} from "@carnet/shared";

type Props = NativeStackScreenProps<RootStackParamList, "Capture">;

/** Local-date YYYY-MM-DD (NOT UTC). Late-evening captures in UTC- timezones
 * must land in today's journal, not tomorrow's. */
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Phase = "input" | "submitting" | "preview" | "saved";

/** Pending OmniRoute idea result — held in state until user confirms save. */
interface PendingIdea {
  slug: string;
  markdown: string;
  model: string;
}

/** Pending OmniRoute journal result — held until user confirms save. */
interface PendingJournal {
  date: string;
  markdown: string;
  model: string;
}

/** Pending OmniRoute person result — held until user confirms save. */
interface PendingPerson {
  firstName: string;
  lastName: string;
  markdown: string;
  model: string;
}

export default function CaptureScreen({ route, navigation }: Props) {
  const mode: CaptureMode = route.params.mode;
  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [response, setResponse] = useState<CaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OmniRoute path: preview data before file write
  const [pendingIdea, setPendingIdea] = useState<PendingIdea | null>(null);
  const [pendingJournal, setPendingJournal] = useState<PendingJournal | null>(null);
  const [pendingPerson, setPendingPerson] = useState<PendingPerson | null>(null);
  // OmniRoute path: filepath only set after confirmSave writes the file
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  // OmniRoute path: model used for display
  const [omniModel, setOmniModel] = useState<string | null>(null);

  const [queueDepth, setQueueDepth] = useState(0);
  const [showSource, setShowSource] = useState(false);
  // Attachments picked but not yet written — held until the capture commits
  // (confirmSave online, or enqueue offline) so cancelling at preview leaves
  // no orphaned binaries on disk. Idea + Journal only.
  const [pending, setPending] = useState<PickedAttachment[]>([]);
  // User-entered tags, merged into the note frontmatter at write time (both the
  // online and offline paths). knownTags backs the autocomplete.
  const [tags, setTags] = useState<string[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // User-selected location as a `lat,lon` string, injected into frontmatter on save.
  const [location, setLocation] = useState<string | null>(null);
  // Save-first vs. blocking-preview for Idea. Default false = save-first (the raw
  // note is written immediately, enrichment updates it in place). Loaded from
  // settings on mount; Journal/Person never consult it.
  const [previewBeforeSave, setPreviewBeforeSave] = useState(false);
  // Saved-screen state for the save-first Idea failure paths (mirrors photo):
  // `degradedReason` = permanent enrichment failure (raw note kept, Re-enrich
  // offered); `enrichNotice` = an info line (queued offline, or conflict).
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);
  // The captured Idea inputs, stashed so the saved-screen Re-enrich can re-run
  // enrichment against the same text/tags/location/attachments after the input
  // fields were cleared.
  const saveFirstCtxRef = useRef<RawIdeaInput | null>(null);

  /** Inject the selected location into a note's frontmatter (no-op when unset). */
  const withLocation = (markdown: string): string =>
    location ? upsertFrontmatterField(markdown, "location", location) : markdown;

  useEffect(() => {
    void getQueueDepth().then(setQueueDepth);
    // Drain any queued captures on screen open
    void drainQueue().then(() => getQueueDepth().then(setQueueDepth));
    // Load the vault tag index for autocomplete (cache-first; never blocks UI).
    void getTagIndex()
      .then((index) => setKnownTags(index.tags.map((entry) => entry.tag)))
      .catch(() => {});
    // Load the save-first preference (default false = save-first).
    void getSettings()
      .then((s) => setPreviewBeforeSave(s.previewBeforeSave))
      .catch(() => {});
  }, []);

  const currentStatus = useMemo(
    () => parseStatusFromMarkdown(response?.preview_markdown ?? ""),
    [response?.preview_markdown],
  );

  const canSubmit = useMemo(() => {
    if (phase !== "input") return false;
    if (mode === "idea") return text.trim().length > 0;
    if (mode === "journal") return transcript.trim().length > 0 || text.trim().length > 0;
    return ocrText.trim().length > 0 || text.trim().length > 0;
  }, [phase, mode, text, transcript, ocrText]);

  // Handle to the active VoiceButton (Idea/Journal). Lets the attach handlers
  // gracefully stop dictation + commit the partial transcript before the picker
  // opens — otherwise the picker Activity backgrounds the app and the in-flight
  // transcript is stranded (never emitted as final).
  const voiceRef = useRef<VoiceButtonHandle>(null);

  /** Open the picker and stage the chosen attachment. Surfaces the friendly
   * cap/read error from pickAttachment rather than dropping it. */
  const addAttachment = async (imagesOnly: boolean): Promise<void> => {
    voiceRef.current?.stopAndFlush();
    setError(null);
    try {
      const picked = await pickAttachment({ imagesOnly });
      if (picked) setPending((prev) => [...prev, picked]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAttachment = (index: number): void => {
    // No stopAndFlush() here: removing a staged chip is a pure state update with
    // no Activity switch, so dictation isn't interrupted — flushing would only
    // force-stop the mic mid-sentence. The picker path (addAttachment) is the one
    // that backgrounds the app and needs the flush.
    setPending((prev) => prev.filter((_, i) => i !== index));
  };

  // Remembers which staged attachments are already on disk, keyed by the
  // picked-attachment object. A failed commit (writeIdea/enqueue threw) leaves
  // `pending` intact; without this a retry would re-run writeBinary and, since
  // findCollisionFreeName never overwrites, strand the first write as an
  // orphan (`sketch.jpg` unreferenced, `sketch-2.jpg` linked). Keying by object
  // identity also means removing an attachment between attempts drops it
  // cleanly and a newly-added one still gets written.
  const persistedRefs = useRef(new WeakMap<PickedAttachment, AttachmentRef>());

  /** Write every staged attachment to the vault (once each) and return the
   * rel-path references to embed/queue. Called at the commit moment
   * (confirmSave or enqueue) so a cancel at preview never strands binaries.
   * Uses the collision-bumped `finalName` for the link so it stays paired. */
  const persistAttachments = async (): Promise<AttachmentRef[]> => {
    const refs: AttachmentRef[] = [];
    for (const p of pending) {
      const cached = persistedRefs.current.get(p);
      if (cached) {
        refs.push(cached);
        continue;
      }
      const subdir = p.kind === "image" ? "Photos" : "Files";
      const ext = extFromMime(p.mime);
      const base = slugify(p.filename.replace(/\.[^.]+$/, "")) || "attachment";
      const { finalName } = await writeBinary(
        subdir,
        `${base}.${ext}`,
        p.base64,
        p.mime,
      );
      const ref: AttachmentRef = {
        kind: p.kind,
        rel: `../${subdir}/${finalName}`,
        filename: finalName,
      };
      persistedRefs.current.set(p, ref);
      refs.push(ref);
    }
    return refs;
  };

  /** Build an offline-or-error handler. Permanent errors (4xx) surface to
   * the user with the actual message; transient errors (network / 5xx)
   * enqueue silently with a "queued for sync" notice. */
  const handleCaptureError = async (
    e: unknown,
    enqueueFn: () => Promise<void>,
  ): Promise<void> => {
    // A blank OmniRoute URL is a configuration problem, not an offline blip.
    // Queuing it would "succeed" silently and retry forever against a
    // nonexistent endpoint — so surface it and keep the text for resend.
    if (isNotConfiguredError(e)) {
      setError("OmniRoute URL not configured — set it in Settings.");
      setPhase("input");
      return;
    }
    if (isPermanentError(e)) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("input");
      return;
    }
    // Wrap the queue write so a failure here can never strand the user on the
    // "submitting" spinner — the finally always returns to the input phase.
    try {
      await enqueueFn();
      const depth = await getQueueDepth();
      setQueueDepth(depth);
      setError("Offline — capture queued.");
      // The capture is safely persisted in the queue — clear the inputs so the
      // next capture starts fresh. Permanent (4xx) errors above intentionally
      // keep the text so the user can fix the problem and resend.
      setText("");
      setTranscript("");
      setOcrText("");
      setPending([]);
      setTags([]);
      setLocation(null);
    } catch (qe: unknown) {
      const qmsg = qe instanceof Error ? qe.message : String(qe);
      setError(`Couldn't reach OmniRoute, and queuing offline failed: ${qmsg}`);
    } finally {
      setPhase("input");
    }
  };

  /** Map a save-first enrichment outcome onto the UI: success closes the
   * screen; conflict/queued surface an info banner; permanent failure surfaces
   * the degraded banner + Re-enrich. The raw note is already on disk in every
   * branch, so nothing is ever lost. `mtime` is the guard baseline to re-queue
   * with on a transient failure. */
  const finishSaveFirst = async (
    outcome: EnrichIdeaOutcome,
    ctx: RawIdeaInput,
    filepath: string,
    mtime: number | null,
  ): Promise<void> => {
    if (outcome.kind === "updated") {
      setPhase("saved");
      navigation.goBack();
      return;
    }
    if (outcome.kind === "conflict") {
      setEnrichNotice(
        "This note changed on disk during enrichment — your version was kept.",
      );
      setPhase("saved");
      return;
    }
    // outcome.kind === "failed"
    if (outcome.transient) {
      try {
        await enqueue({
          mode: "idea",
          text: ctx.text,
          attachments: ctx.attachments,
          tags: ctx.tags,
          location: ctx.location,
          // Update the raw note we already wrote in place on drain — do NOT
          // write a duplicate.
          filepath,
          baselineMtime: mtime,
        });
        setQueueDepth(await getQueueDepth());
        setEnrichNotice(
          "Saved as a raw note — enrichment queued and will finish when OmniRoute is reachable.",
        );
      } catch {
        setEnrichNotice(
          "Saved as a raw note — enrichment will retry next time you open carnet.",
        );
      }
    } else {
      setDegradedReason(outcome.reason);
    }
    setPhase("saved");
  };

  /** Re-run enrichment on the already-saved raw note from the saved screen.
   * Re-reads the mtime as a fresh guard baseline (the note may have synced). */
  const reEnrichSaved = async (): Promise<void> => {
    const ctx = saveFirstCtxRef.current;
    if (!ctx || !savedFilepath) return;
    setError(null);
    setDegradedReason(null);
    setEnrichNotice(null);
    setPhase("submitting");
    const baseline = await getModificationTime(savedFilepath);
    const outcome = await enrichIdeaInPlace({
      filepath: savedFilepath,
      expectedMtime: baseline,
      text: ctx.text,
      tags: ctx.tags,
      location: ctx.location,
      attachments: ctx.attachments,
    });
    await finishSaveFirst(outcome, ctx, savedFilepath, baseline);
  };

  const submit = async () => {
    setPhase("submitting");
    setError(null);
    setDegradedReason(null);
    setEnrichNotice(null);

    if (mode === "idea") {
      // Blocking-preview (opt-in): enrich → preview → Save, exactly as before.
      if (previewBeforeSave) {
        try {
          const result = await enrichIdea(text.trim());
          const title = deriveTitle(result.markdown);
          const slug = slugify(title) || "untitled";
          setPendingIdea({ slug, markdown: result.markdown, model: result.model });
          setOmniModel(result.model);
          setResponse({
            type: "capture_response",
            request_id: "",
            status: "ok",
            preview_markdown: result.markdown,
          });
          setPhase("preview");
        } catch (e: unknown) {
          await handleCaptureError(e, async () => {
            // Write the binaries to disk first (local + offline-safe), then
            // queue only their rel-paths — never base64.
            const refs = await persistAttachments();
            await enqueue({
              mode: "idea",
              text: text.trim(),
              attachments: refs,
              tags,
              location: location ?? undefined,
            });
          });
        }
        return;
      }

      // Save-first (default): write the raw note NOW, then enrich it in place.
      try {
        const refs = await persistAttachments();
        const ctx: RawIdeaInput = {
          text: text.trim(),
          tags,
          location: location ?? undefined,
          attachments: refs,
        };
        const { filepath, mtime } = await writeRawIdea(ctx);
        const title = deriveTitle(ctx.text) || "Idea";
        await recordCapture({
          id: localId(),
          mode,
          title,
          filepath,
          createdAt: Date.now(),
        });
        void invalidateTagIndex().catch(() => undefined);
        setSavedFilepath(filepath);
        saveFirstCtxRef.current = ctx;
        // The capture is safely persisted — clear the inputs so a back-out
        // leaves nothing staged and the next capture starts fresh.
        setPending([]);
        setTags([]);
        setLocation(null);
        setText("");
        const outcome = await enrichIdeaInPlace({
          filepath,
          expectedMtime: mtime,
          text: ctx.text,
          tags: ctx.tags,
          location: ctx.location,
          attachments: ctx.attachments,
        });
        await finishSaveFirst(outcome, ctx, filepath, mtime);
      } catch (e: unknown) {
        // The raw write itself failed (disk/permission) — nothing was saved,
        // so keep the inputs and return the user to the form.
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase("input");
      }
      return;
    }

    if (mode === "journal") {
      const combined = [transcript, text].map((s) => s.trim()).filter(Boolean).join("\n\n");
      try {
        const result = await enrichJournal({ transcript: combined, notes: "" });
        const today = todayLocal();
        setPendingJournal({ date: today, markdown: result.markdown, model: result.model });
        setOmniModel(result.model);
        setResponse({
          type: "capture_response",
          request_id: "",
          status: "ok",
          preview_markdown: result.markdown,
        });
        setPhase("preview");
      } catch (e: unknown) {
        await handleCaptureError(e, async () => {
          const refs = await persistAttachments();
          await enqueue({
            mode: "journal",
            transcript: combined,
            notes: "",
            date: todayLocal(),
            attachments: refs,
            tags,
            location: location ?? undefined,
          });
        });
      }
      return;
    }

    // mode === "person"
    try {
      const result = await enrichPerson({ ocrResult: ocrText.trim(), context: text.trim() });
      const nameField = extractNameFromMarkdown(result.markdown);
      setPendingPerson({
        firstName: nameField.firstName,
        lastName: nameField.lastName,
        markdown: result.markdown,
        model: result.model,
      });
      setOmniModel(result.model);
      setResponse({
        type: "capture_response",
        request_id: "",
        status: "ok",
        preview_markdown: result.markdown,
      });
      setPhase("preview");
    } catch (e: unknown) {
      await handleCaptureError(e, () =>
        enqueue({
          mode: "person",
          ocrResult: ocrText.trim(),
          context: text.trim(),
          tags,
          location: location ?? undefined,
        }),
      );
    }
  };

  const confirmSave = async () => {
    console.log("[confirmSave] tapped", { mode, hasPending: !!(pendingIdea || pendingJournal || pendingPerson) });
    if (mode === "idea" && pendingIdea) {
      try {
        console.log("[confirmSave] writeIdea start", { slug: pendingIdea.slug });
        const refs = await persistAttachments();
        const markdown = withLocation(
          mergeUserTags(injectAttachments(pendingIdea.markdown, refs), tags),
        );
        const { filepath } = await writeIdea(pendingIdea.slug, markdown);
        console.log("[confirmSave] writeIdea ok", filepath);
        setPending([]);
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingIdea.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void invalidateTagIndex().catch(() => undefined);
        console.log("[confirmSave] recordCapture ok");
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[confirmSave] idea failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "journal" && pendingJournal) {
      try {
        console.log("[confirmSave] appendJournal start", { date: pendingJournal.date });
        const refs = await persistAttachments();
        const markdown = withLocation(
          mergeUserTags(injectAttachments(pendingJournal.markdown, refs), tags),
        );
        const { filepath } = await appendJournal(pendingJournal.date, markdown);
        console.log("[confirmSave] appendJournal ok", filepath);
        setPending([]);
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingJournal.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void invalidateTagIndex().catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[confirmSave] journal failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "person" && pendingPerson) {
      try {
        console.log("[confirmSave] writePerson start");
        const markdown = withLocation(mergeUserTags(pendingPerson.markdown, tags));
        const { filepath } = await writePerson(
          pendingPerson.firstName,
          pendingPerson.lastName,
          markdown,
        );
        console.log("[confirmSave] writePerson ok", filepath);
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingPerson.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void invalidateTagIndex().catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[confirmSave] person failed:", msg, e);
        setError(msg);
      }
    }
  };

  const promote = async (next: IdeaStatus) => {
    if (next === currentStatus || !pendingIdea) return;
    setError(null);

    try {
      const currentMd = response?.preview_markdown ?? pendingIdea.markdown;
      const result = await omniPromoteIdea(currentMd, next);
      const newSlug = slugify(deriveTitle(result.markdown)) || pendingIdea.slug;
      setPendingIdea({ slug: newSlug, markdown: result.markdown, model: result.model });
      setOmniModel(result.model);
      setResponse({
        type: "capture_response",
        request_id: "",
        status: "ok",
        preview_markdown: result.markdown,
        filepath: savedFilepath ?? undefined,
      });

      // If file was already written, update it on disk — guarded by the mtime
      // check so a workstation edit synced in between our read and write is kept
      // rather than clobbered (closes the promote-idea race, TODO.md).
      if (savedFilepath) {
        const baseline = await getModificationTime(savedFilepath);
        let conflict = false;
        try {
          const existing = await readNote(savedFilepath);
          const patched = rewriteFrontmatterField(existing, "status", next);
          const res = await updateNoteIfUnchanged(savedFilepath, patched, baseline);
          conflict = !res.ok;
        } catch {
          const res = await updateNoteIfUnchanged(savedFilepath, result.markdown, baseline);
          conflict = !res.ok;
        }
        if (conflict) {
          setError(
            "This note changed on disk — reopen it before promoting so your edits aren't lost.",
          );
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {phase === "input" && (
        <ModeInput
          mode={mode}
          text={text}
          onTextChange={setText}
          transcript={transcript}
          onTranscriptChange={setTranscript}
          ocrText={ocrText}
          onOcrChange={setOcrText}
          voiceRef={voiceRef}
        />
      )}

      {phase === "input" && mode !== "person" && (
        <View style={styles.attachBlock}>
          <View style={styles.attachRow}>
            <Button
              icon="image"
              mode="contained-tonal"
              compact
              onPress={() => addAttachment(true)}
            >
              Image
            </Button>
            <Button
              icon="paperclip"
              mode="contained-tonal"
              compact
              onPress={() => addAttachment(false)}
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
                  onClose={() => removeAttachment(i)}
                  compact
                >
                  {p.filename}
                </Chip>
              ))}
            </View>
          )}
        </View>
      )}

      {phase === "input" && (
        <TagInput tags={tags} onChange={setTags} knownTags={knownTags} />
      )}

      {phase === "input" && <LocationChip location={location} onChange={setLocation} />}

      {phase === "input" && (
        <>
          <Button
            mode="contained"
            onPress={submit}
            disabled={!canSubmit}
            style={styles.submit}
          >
            Send
          </Button>
          {queueDepth > 0 && (
            <HelperText type="info" visible>
              {queueDepth} capture{queueDepth > 1 ? "s" : ""} pending sync
            </HelperText>
          )}
          {error && (
            <HelperText type="error" visible>
              {error}
            </HelperText>
          )}
        </>
      )}

      {phase === "submitting" && (
        <View style={styles.loading}>
          <ActivityIndicator animating size="large" />
          <Text variant="bodyMedium" style={styles.loadingText}>
            OmniRoute is structuring the note…
          </Text>
        </View>
      )}

      {phase === "preview" && response && (
        <Card style={styles.previewCard}>
          <Card.Title
            title="Preview"
            subtitle={(() => {
              const filename =
                mode === "idea" && pendingIdea
                  ? `Ideas/${pendingIdea.slug}.md`
                  : mode === "journal" && pendingJournal
                    ? `Journal/${pendingJournal.date}.md`
                    : mode === "person" && pendingPerson
                      ? `People/${pendingPerson.firstName}-${pendingPerson.lastName}.md`
                      : "";
              return `${filename}${omniModel ? ` • ${omniModel}` : ""}`;
            })()}
          />
          <Card.Content>
            {mode === "idea" && (
              <View style={styles.statusRow}>
                {IDEA_STATUSES.map((s) => (
                  <Chip
                    key={s}
                    selected={currentStatus === s}
                    onPress={() => promote(s)}
                    style={styles.statusChip}
                    compact
                  >
                    {s}
                  </Chip>
                ))}
              </View>
            )}
            <Text
              selectable
              style={showSource ? styles.previewSource : styles.previewRendered}
            >
              {response.preview_markdown ?? ""}
            </Text>
          </Card.Content>
          <Card.Actions>
            <Button
              mode="text"
              compact
              onPress={() => setShowSource((v) => !v)}
            >
              {showSource ? "View rendered" : "View source"}
            </Button>
            <Button onPress={confirmSave} mode="contained">
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
      )}

      {phase === "saved" && (degradedReason || enrichNotice) && (
        <Card style={styles.previewCard}>
          <Card.Title title="Saved to vault" />
          <Card.Content>
            {degradedReason ? (
              <Banner visible icon="alert" actions={[]} style={styles.degradedBanner}>
                {`Saved as a raw note — AI enrichment failed. ${degradedReason}`}
              </Banner>
            ) : null}
            {enrichNotice ? (
              <Banner
                visible
                icon="information"
                actions={[]}
                style={styles.degradedBanner}
              >
                {enrichNotice}
              </Banner>
            ) : null}
            <Text variant="bodySmall" selectable style={styles.previewRendered}>
              {savedFilepath ?? ""}
            </Text>
            <HelperText type="info" visible>
              Open Obsidian (or your editor) on the synced folder to read and
              edit. Carnet is intake-only.
            </HelperText>
          </Card.Content>
          <Card.Actions>
            {degradedReason ? (
              <Button mode="text" onPress={reEnrichSaved}>
                Re-enrich
              </Button>
            ) : null}
            <Button mode="contained" onPress={() => navigation.goBack()}>
              Done
            </Button>
          </Card.Actions>
        </Card>
      )}
    </ScrollView>
  );
}

interface ModeInputProps {
  mode: CaptureMode;
  text: string;
  onTextChange: (v: string) => void;
  transcript: string;
  onTranscriptChange: (v: string) => void;
  ocrText: string;
  onOcrChange: (v: string) => void;
  /** Forwarded to the Idea/Journal VoiceButton so the parent can stop+flush
   * dictation before opening the attachment picker. */
  voiceRef?: Ref<VoiceButtonHandle>;
}

function ModeInput({
  mode,
  text,
  onTextChange,
  transcript,
  onTranscriptChange,
  ocrText,
  onOcrChange,
  voiceRef,
}: ModeInputProps) {
  if (mode === "idea") {
    return (
      <View style={styles.ideaBlock}>
        <View style={styles.voiceRow}>
          <VoiceButton
            ref={voiceRef}
            onTranscript={(t, isFinal) => {
              if (isFinal) {
                onTextChange(text ? `${text}\n${t}`.trim() : t);
              }
            }}
          />
          <Text variant="bodySmall" style={styles.voiceHint}>
            Tap to dictate
          </Text>
        </View>
        <TextInput
          label="Your idea"
          mode="outlined"
          multiline
          numberOfLines={6}
          value={text}
          onChangeText={onTextChange}
          autoFocus
        />
        <Text variant="bodySmall" style={styles.wordCounter}>
          {text.length} chars
        </Text>
      </View>
    );
  }
  if (mode === "journal") {
    return (
      <View style={styles.journalBlock}>
        <View style={styles.voiceRow}>
          <VoiceButton
            ref={voiceRef}
            onTranscript={(t, isFinal) => {
              if (isFinal) {
                onTranscriptChange(
                  transcript ? `${transcript}\n${t}`.trim() : t,
                );
              }
            }}
          />
          <Text variant="bodySmall" style={styles.voiceHint}>
            Tap to dictate
          </Text>
        </View>
        <TextInput
          label="Transcript"
          mode="outlined"
          multiline
          numberOfLines={5}
          value={transcript}
          onChangeText={onTranscriptChange}
        />
        <TextInput
          label="Additional notes"
          mode="outlined"
          multiline
          numberOfLines={3}
          value={text}
          onChangeText={onTextChange}
        />
      </View>
    );
  }
  return (
    <PersonInput
      ocrText={ocrText}
      onOcrChange={onOcrChange}
      context={text}
      onContextChange={onTextChange}
    />
  );
}

interface PersonInputProps {
  ocrText: string;
  onOcrChange: (v: string) => void;
  context: string;
  onContextChange: (v: string) => void;
}

function PersonInput({
  ocrText,
  onOcrChange,
  context,
  onContextChange,
}: PersonInputProps) {
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const open = async () => {
    setHint(null);
    const settings = await getSettings();
    if (!settings.omniRouteUrl.trim()) {
      setHint(
        "OmniRoute not configured. Type the card text below, then tap Send.",
      );
      return;
    }
    setScannerVisible(true);
  };

  return (
    <View style={styles.personBlock}>
      <Button icon="camera" mode="contained-tonal" onPress={open}>
        Scan card
      </Button>
      {hint && (
        <HelperText type="info" visible>
          {hint}
        </HelperText>
      )}
      <TextInput
        label="OCR text (business card)"
        mode="outlined"
        multiline
        numberOfLines={4}
        value={ocrText}
        onChangeText={onOcrChange}
      />
      <View style={styles.voiceRow}>
        <VoiceButton
          onTranscript={(t, isFinal) => {
            if (isFinal) {
              onContextChange(context ? `${context}\n${t}`.trim() : t);
            }
          }}
        />
        <Text variant="bodySmall" style={styles.voiceHint}>
          Tap to dictate meeting context
        </Text>
      </View>
      <TextInput
        label="Meeting context"
        mode="outlined"
        multiline
        numberOfLines={3}
        value={context}
        onChangeText={onContextChange}
      />
      <CardScannerModal
        visible={scannerVisible}
        onResult={(text) => {
          onOcrChange(ocrText ? `${ocrText}\n${text}`.trim() : text);
        }}
        onClose={() => setScannerVisible(false)}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  submit: { marginTop: 12 },
  loading: { paddingVertical: 64, alignItems: "center", gap: 12 },
  loadingText: { opacity: 0.8 },
  previewCard: { marginTop: 8 },
  previewSource: { fontFamily: "monospace", fontSize: 12, marginTop: 12 },
  previewRendered: { fontSize: 13, lineHeight: 20, marginTop: 12 },
  statusRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  statusChip: {},
  ideaBlock: { gap: 12 },
  journalBlock: { gap: 12 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  personBlock: { gap: 12 },
  wordCounter: { opacity: 0.5, marginTop: 4, textAlign: "right" },
  attachBlock: { gap: 8 },
  attachRow: { flexDirection: "row", gap: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  degradedBanner: { marginBottom: 8 },
});
