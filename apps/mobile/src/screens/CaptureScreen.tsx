import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Card,
  Chip,
  HelperText,
  Text,
  TextInput,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { v4 as uuidv4 } from "uuid";

import type { RootStackParamList } from "../../App";
import { VoiceButton } from "../voice/VoiceButton";
import { CardScannerModal } from "../components/CardScannerModal";
import { getSettings } from "../lib/settings";
import { recordCapture, type CaptureMode } from "../lib/storage";
import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  isPermanentError,
  promoteIdea as omniPromoteIdea,
} from "../lib/omniroute";
import {
  slugify,
  writeIdea,
  appendJournal,
  writePerson,
  readNote,
  updateNote,
  rewriteFrontmatterField,
  extractNameFromMarkdown,
} from "../lib/writer";
import { enqueue, drainQueue, getQueueDepth } from "../lib/queue";
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

  useEffect(() => {
    void getQueueDepth().then(setQueueDepth);
    // Drain any queued captures on screen open
    void drainQueue().then(() => getQueueDepth().then(setQueueDepth));
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

  /** Build an offline-or-error handler. Permanent errors (4xx) surface to
   * the user with the actual message; transient errors (network / 5xx)
   * enqueue silently with a "queued for sync" notice. */
  const handleCaptureError = async (
    e: unknown,
    enqueueFn: () => Promise<void>,
  ): Promise<void> => {
    if (isPermanentError(e)) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("input");
      return;
    }
    await enqueueFn();
    const depth = await getQueueDepth();
    setQueueDepth(depth);
    setError("Offline — capture queued.");
    setPhase("input");
  };

  const submit = async () => {
    setPhase("submitting");
    setError(null);

    if (mode === "idea") {
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
        await handleCaptureError(e, () =>
          enqueue({ mode: "idea", text: text.trim() }),
        );
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
        await handleCaptureError(e, () =>
          enqueue({ mode: "journal", transcript: combined, notes: "", date: todayLocal() }),
        );
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
        enqueue({ mode: "person", ocrResult: ocrText.trim(), context: text.trim() }),
      );
    }
  };

  const confirmSave = async () => {
    if (mode === "idea" && pendingIdea) {
      try {
        const { filepath } = await writeIdea(pendingIdea.slug, pendingIdea.markdown);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingIdea.markdown);
        await recordCapture({ id: uuidv4(), mode, title, filepath, createdAt: Date.now() });
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (mode === "journal" && pendingJournal) {
      try {
        const { filepath } = await appendJournal(pendingJournal.date, pendingJournal.markdown);
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingJournal.markdown);
        await recordCapture({ id: uuidv4(), mode, title, filepath, createdAt: Date.now() });
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (mode === "person" && pendingPerson) {
      try {
        const { filepath } = await writePerson(
          pendingPerson.firstName,
          pendingPerson.lastName,
          pendingPerson.markdown,
        );
        setSavedFilepath(filepath);
        const title = deriveTitle(pendingPerson.markdown);
        await recordCapture({ id: uuidv4(), mode, title, filepath, createdAt: Date.now() });
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
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

      // If file was already written, update it on disk
      if (savedFilepath) {
        try {
          const existing = await readNote(savedFilepath);
          const patched = rewriteFrontmatterField(existing, "status", next);
          await updateNote(savedFilepath, patched);
        } catch {
          await updateNote(savedFilepath, result.markdown);
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {phase === "input" && (
        <ModeInput
          mode={mode}
          text={text}
          onTextChange={setText}
          transcript={transcript}
          onTranscriptChange={setTranscript}
          ocrText={ocrText}
          onOcrChange={setOcrText}
        />
      )}

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
}

function ModeInput({
  mode,
  text,
  onTextChange,
  transcript,
  onTranscriptChange,
  ocrText,
  onOcrChange,
}: ModeInputProps) {
  if (mode === "idea") {
    return (
      <View>
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
            onTranscript={(t, isFinal) => {
              if (isFinal) {
                onTranscriptChange(
                  transcript ? `${transcript}\n${t}`.trim() : t,
                );
              }
            }}
          />
          <Text variant="bodySmall" style={styles.voiceHint}>
            Hold to record
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
  journalBlock: { gap: 12 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  personBlock: { gap: 12 },
  wordCounter: { opacity: 0.5, marginTop: 4, textAlign: "right" },
});
