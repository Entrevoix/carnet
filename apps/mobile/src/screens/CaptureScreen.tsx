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
import { enrichIdea, enrichJournal, enrichPerson, promoteIdea as omniPromoteIdea } from "../lib/omniroute";
import { slugify, writeIdea, appendJournal, writePerson, readNote, updateNote, rewriteFrontmatterField } from "../lib/writer";
import { enqueue, drainQueue, getQueueDepth } from "../lib/queue";
import {
  IDEA_STATUSES,
  deriveTitle,
  parseStatusFromMarkdown,
  type CaptureResponse,
  type IdeaStatus,
} from "@carnet/shared";

type Props = NativeStackScreenProps<RootStackParamList, "Capture">;

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
        await enqueue({ mode: "idea", text: text.trim() });
        const depth = await getQueueDepth();
        setQueueDepth(depth);
        setError("Pas de connexion — capture mise en file d'attente.");
        setPhase("input");
      }
      return;
    }

    if (mode === "journal") {
      try {
        const combined = [transcript, text].map((s) => s.trim()).filter(Boolean).join("\n\n");
        const result = await enrichJournal({ transcript: combined, notes: "" });
        const today = new Date().toISOString().slice(0, 10);
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
        const combined = [transcript, text].map((s) => s.trim()).filter(Boolean).join("\n\n");
        const today = new Date().toISOString().slice(0, 10);
        await enqueue({ mode: "journal", transcript: combined, notes: "", date: today });
        const depth = await getQueueDepth();
        setQueueDepth(depth);
        setError("Pas de connexion — capture mise en file d'attente.");
        setPhase("input");
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
      await enqueue({ mode: "person", ocrResult: ocrText.trim(), context: text.trim() });
      const depth = await getQueueDepth();
      setQueueDepth(depth);
      setError("Pas de connexion — capture mise en file d'attente.");
      setPhase("input");
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
            Envoyer
          </Button>
          {queueDepth > 0 && (
            <HelperText type="info" visible>
              {queueDepth} capture{queueDepth > 1 ? "s" : ""} en attente de sync
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
            OmniRoute structure la note…
          </Text>
        </View>
      )}

      {phase === "preview" && response && (
        <Card style={styles.previewCard}>
          <Card.Title
            title="Aperçu"
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
              {showSource ? "Voir rendu" : "Voir source"}
            </Button>
            <Button onPress={confirmSave} mode="contained">
              Enregistrer
            </Button>
          </Card.Actions>
        </Card>
      )}
    </ScrollView>
  );
}

/** Extract first/last name from a person markdown note. */
function extractNameFromMarkdown(markdown: string): { firstName: string; lastName: string } {
  // Try `name:` frontmatter field first
  const s = markdown.trimStart();
  if (s.startsWith("---")) {
    const afterFirst = s.slice(3);
    const endIdx = afterFirst.indexOf("\n---");
    if (endIdx !== -1) {
      const block = afterFirst.slice(0, endIdx);
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("name:")) {
          const name = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, "");
          const parts = name.split(/\s+/);
          if (parts.length >= 2) {
            return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
          }
          if (parts.length === 1) {
            return { firstName: parts[0], lastName: "" };
          }
        }
      }
    }
  }
  // Fall back to H1
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const name = trimmed.slice(2).trim();
      const parts = name.split(/\s+/);
      if (parts.length >= 2) {
        return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
      }
      return { firstName: name, lastName: "" };
    }
  }
  return { firstName: "", lastName: "" };
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
          label="Ton idée"
          mode="outlined"
          multiline
          numberOfLines={6}
          value={text}
          onChangeText={onTextChange}
          autoFocus
        />
        <Text variant="bodySmall" style={styles.wordCounter}>
          {text.length} car.
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
            Maintenir pour enregistrer
          </Text>
        </View>
        <TextInput
          label="Transcription"
          mode="outlined"
          multiline
          numberOfLines={5}
          value={transcript}
          onChangeText={onTranscriptChange}
        />
        <TextInput
          label="Notes additionnelles"
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
        "OmniRoute non configuré. Saisis le texte de la carte ci-dessous, puis Envoyer.",
      );
      return;
    }
    setScannerVisible(true);
  };

  return (
    <View style={styles.personBlock}>
      <Button icon="camera" mode="contained-tonal" onPress={open}>
        Scanner la carte
      </Button>
      {hint && (
        <HelperText type="info" visible>
          {hint}
        </HelperText>
      )}
      <TextInput
        label="Texte OCR (carte de visite)"
        mode="outlined"
        multiline
        numberOfLines={4}
        value={ocrText}
        onChangeText={onOcrChange}
      />
      <TextInput
        label="Contexte de la rencontre"
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
