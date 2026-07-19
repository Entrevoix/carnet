import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  HelperText,
  IconButton,
  Text,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
// Non-crypto local ID — only used as a key for the recents history list,
// not for anything security-sensitive. uuid v11 requires crypto.getRandomValues
// which RN doesn't provide without the react-native-get-random-values polyfill
// (which would require a native rebuild). This avoids that whole detour.
const localId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

import type { RootStackParamList } from "../../App";
import type { VoiceButtonHandle } from "../voice/VoiceButton";
import { ModeInput } from "../components/CaptureModeInput";
import {
  CaptureMetaSheet,
  CapturePreviewCard,
  CaptureSavedCard,
} from "../components/CaptureViews";
import { getSettings } from "../lib/settings";
import { recordCapture, type CaptureMode } from "../lib/storage";
import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  promoteIdea as omniPromoteIdea,
} from "../lib/dispatcher";
import {
  slugify,
  writeIdea,
  appendJournal,
  writePerson,
  injectAttachments,
  getModificationTime,
  extractNameFromMarkdown,
  type AttachmentRef,
} from "../lib/writer";
import {
  enrichIdeaInPlace,
  writeRawIdea,
  type EnrichIdeaOutcome,
  type RawIdeaInput,
} from "../lib/ideaSaveFirst";
import { classifyCaptureError } from "../lib/captureErrorDecision";
import { planSaveFirstOutcome } from "../lib/saveFirstOutcome";
import { persistAttachments as persistAttachmentsToVault } from "../lib/attachmentPersistence";
import { promoteIdeaOnDisk } from "../lib/promoteIdeaOnDisk";
import { pickAttachment, type PickedAttachment } from "../lib/attachments";
import { clearDraft, loadDraft, saveDraft } from "../lib/captureDraft";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { enqueue, drainQueue, getQueueDepth } from "../lib/queue";
import { mergeUserTags } from "../lib/tags";
import { upsertFrontmatterField } from "../lib/frontmatter";
import { getTagIndex, upsertNoteInIndex } from "../lib/vault";
import {
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
  const theme = useCarnetTheme();
  const [phase, setPhase] = useState<Phase>("input");
  // Metadata (tags/location/attachments) lives in a sheet behind the "+"
  // button so it never blocks writing — capture-first, file later.
  const [metaOpen, setMetaOpen] = useState(false);
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

  // Draft persistence: restore on entry, autosave (debounced) while typing,
  // cleared at every point the capture is safely persisted. State (not a
  // ref) so the autosave effect re-arms as soon as the restore completes —
  // otherwise text typed before loadDraft resolves isn't persisted until
  // the next keystroke. The guard also stops the empty first render from
  // wiping a stored draft before it loads.
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadDraft(mode)
      .then((draft) => {
        if (cancelled || !draft) return;
        // Only fill fields the user hasn't already typed into (e.g. a fast
        // dictation landing before the async load resolves).
        setText((cur) => cur || draft.text);
        setTranscript((cur) => cur || draft.transcript);
        setOcrText((cur) => cur || draft.ocrText);
      })
      // A failed draft read means starting blank — the benign outcome; the
      // finally below still unlatches draft persistence either way.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDraftLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (!draftLoaded || phase !== "input") return;
    const timer = setTimeout(() => {
      saveDraft(mode, { text, transcript, ocrText }).catch(() => {
        // Best-effort: a failed autosave must never surface mid-typing.
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [draftLoaded, mode, phase, text, transcript, ocrText]);

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

  // Preview-card subtitle: the target filename for this mode + the enriching
  // model. Computed here so the presentational card stays mode-agnostic.
  const previewSubtitle = useMemo(() => {
    const filename =
      mode === "idea" && pendingIdea
        ? `Ideas/${pendingIdea.slug}.md`
        : mode === "journal" && pendingJournal
          ? `Journal/${pendingJournal.date}.md`
          : mode === "person" && pendingPerson
            ? `People/${pendingPerson.firstName}-${pendingPerson.lastName}.md`
            : "";
    return `${filename}${omniModel ? ` • ${omniModel}` : ""}`;
  }, [mode, pendingIdea, pendingJournal, pendingPerson, omniModel]);

  // One quiet line summarizing what's staged behind the "+" sheet, so the
  // user can see filing state without opening it.
  const metaSummary = useMemo(() => {
    const parts: string[] = [];
    if (tags.length > 0) parts.push(`${tags.length} tag${tags.length > 1 ? "s" : ""}`);
    if (pending.length > 0)
      parts.push(`${pending.length} attachment${pending.length > 1 ? "s" : ""}`);
    if (location) parts.push("location");
    return parts.join(" · ");
  }, [tags, pending, location]);

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
   * rel-path references to embed/queue. Thin closure over the current staged
   * set + the dedup cache; the write/dedup logic lives in
   * lib/attachmentPersistence so it's unit-testable without a renderer. */
  const persistAttachments = (): Promise<AttachmentRef[]> =>
    persistAttachmentsToVault(pending, persistedRefs.current);

  /** Build an offline-or-error handler. Permanent errors (4xx) surface to
   * the user with the actual message; transient errors (network / 5xx)
   * enqueue silently with a "queued for sync" notice. */
  const handleCaptureError = async (
    e: unknown,
    enqueueFn: () => Promise<void>,
  ): Promise<void> => {
    // A blank OmniRoute URL is a config problem (not an offline blip) and a 4xx
    // is permanent — both surface the message and keep the text for a resend.
    // Only transient (network / 5xx) errors fall through to the offline queue.
    const decision = classifyCaptureError(e);
    if (decision.kind !== "transient") {
      setError(decision.message);
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
      void clearDraft(mode).catch(() => undefined);
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
    const plan = planSaveFirstOutcome(outcome);
    if (plan.kind === "close") {
      // Reflect the enriched note (final tags, pending-enrich status gone)
      // in the cached index before landing back on Home.
      void upsertNoteInIndex(filepath, plan.markdown).catch(() => undefined);
      setPhase("saved");
      navigation.goBack();
      return;
    }
    if (plan.kind === "conflict") {
      setEnrichNotice(plan.notice);
      setPhase("saved");
      return;
    }
    if (plan.kind === "queue") {
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
        setEnrichNotice(plan.notice);
      } catch {
        setEnrichNotice(plan.fallbackNotice);
      }
      setPhase("saved");
      return;
    }
    // plan.kind === "degraded"
    setDegradedReason(plan.reason);
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
    // The "+" metadata button already dismisses on open (QA finding: a still-open
    // keyboard renders over the near-black sheet in dark mode); Send needs the
    // same treatment — otherwise the keyboard stays up through submitting/preview
    // and the user has to back out of it manually.
    Keyboard.dismiss();
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
        const { filepath, mtime, markdown: rawMarkdown } = await writeRawIdea(ctx);
        const title = deriveTitle(ctx.text) || "Idea";
        await recordCapture({
          id: localId(),
          mode,
          title,
          filepath,
          createdAt: Date.now(),
        });
        // Upsert (not invalidate) so Home's cards can show this note's tags
        // and pending-enrich stamp immediately — dropping the whole cached
        // index left cards bare until the next full vault scan.
        void upsertNoteInIndex(filepath, rawMarkdown).catch(() => undefined);
        setSavedFilepath(filepath);
        saveFirstCtxRef.current = ctx;
        // The capture is safely persisted — clear the inputs so a back-out
        // leaves nothing staged and the next capture starts fresh.
        setPending([]);
        setTags([]);
        setLocation(null);
        setText("");
        void clearDraft(mode).catch(() => undefined);
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
    if (mode === "idea" && pendingIdea) {
      try {
        const refs = await persistAttachments();
        const markdown = withLocation(
          mergeUserTags(injectAttachments(pendingIdea.markdown, refs), tags),
        );
        const { filepath } = await writeIdea(pendingIdea.slug, markdown);
        setPending([]);
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingIdea.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void upsertNoteInIndex(filepath, markdown).catch(() => undefined);
        void clearDraft(mode).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] idea failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "journal" && pendingJournal) {
      try {
        const refs = await persistAttachments();
        const markdown = withLocation(
          mergeUserTags(injectAttachments(pendingJournal.markdown, refs), tags),
        );
        // A journal day-file accumulates every same-day capture into one note:
        // appendJournal unions each capture's tags into the file's frontmatter
        // and returns the full accumulated markdown. Index off THAT, not the
        // just-written fragment — otherwise the upsert would overwrite the note's
        // index row with only this capture's tags, silently dropping earlier
        // same-day tags from the derived tag/search index.
        const { filepath, markdown: dayFileMarkdown } = await appendJournal(
          pendingJournal.date,
          markdown,
        );
        setPending([]);
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingJournal.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void upsertNoteInIndex(filepath, dayFileMarkdown).catch(() => undefined);
        void clearDraft(mode).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] journal failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "person" && pendingPerson) {
      try {
        const markdown = withLocation(mergeUserTags(pendingPerson.markdown, tags));
        const { filepath } = await writePerson(
          pendingPerson.firstName,
          pendingPerson.lastName,
          markdown,
        );
        setTags([]);
        setLocation(null);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingPerson.markdown);
        await recordCapture({ id: localId(), mode, title, filepath, createdAt: Date.now() });
        void upsertNoteInIndex(filepath, markdown).catch(() => undefined);
        void clearDraft(mode).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] person failed:", msg, e);
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
        const { conflict } = await promoteIdeaOnDisk(savedFilepath, next, result.markdown);
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

      {phase === "input" && (
        <>
          {/* Single action bar: metadata tucked behind "+" (never blocks
              writing), Send as the one filled CTA on the screen. */}
          <View style={styles.actionBar}>
            <IconButton
              icon="plus-circle-outline"
              size={26}
              onPress={() => {
                // Dismiss the keyboard first: in dark mode a still-open
                // keyboard renders over the near-black sheet and makes it
                // look like the tap did nothing (QA finding).
                Keyboard.dismiss();
                setMetaOpen(true);
              }}
              accessibilityLabel="Add tags, location, or attachments"
            />
            {metaSummary ? (
              <Text
                variant="labelSmall"
                style={[styles.metaSummary, { color: theme.colors.onSurfaceVariant }]}
                onPress={() => setMetaOpen(true)}
                numberOfLines={1}
              >
                {metaSummary}
              </Text>
            ) : (
              <View style={styles.metaSummary} />
            )}
            <Button
              mode="contained"
              onPress={submit}
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

          <CaptureMetaSheet
            visible={metaOpen}
            onDismiss={() => setMetaOpen(false)}
            tags={tags}
            onTagsChange={setTags}
            knownTags={knownTags}
            location={location}
            onLocationChange={setLocation}
            showAttachments={mode !== "person"}
            pending={pending}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
          />
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
        <CapturePreviewCard
          subtitle={previewSubtitle}
          previewMarkdown={response.preview_markdown ?? ""}
          showStatusRow={mode === "idea"}
          currentStatus={currentStatus}
          onPromote={promote}
          showSource={showSource}
          onToggleSource={() => setShowSource((v) => !v)}
          onSave={confirmSave}
          error={error}
        />
      )}

      {phase === "saved" && (degradedReason || enrichNotice) && (
        <CaptureSavedCard
          degradedReason={degradedReason}
          enrichNotice={enrichNotice}
          savedFilepath={savedFilepath}
          onReEnrich={reEnrichSaved}
          onDone={() => navigation.goBack()}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
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
