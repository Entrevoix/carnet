import { useMemo, useState } from "react";
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
import { getClient } from "../lib/client";
import { useConnectionStatus } from "../lib/useConnectionStatus";
import { getSettings } from "../lib/settings";
import { recordCapture, type CaptureMode } from "../lib/storage";
import {
  IDEA_STATUSES,
  deriveTitle,
  parseStatusFromMarkdown,
  type CaptureResponse,
  type IdeaStatus,
} from "@carnet/shared";

type Props = NativeStackScreenProps<RootStackParamList, "Capture">;

type Phase = "input" | "submitting" | "preview" | "saved";

export default function CaptureScreen({ route, navigation }: Props) {
  const mode: CaptureMode = route.params.mode;
  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [response, setResponse] = useState<CaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useConnectionStatus();

  const currentStatus = useMemo(
    () => parseStatusFromMarkdown(response?.preview_markdown ?? ""),
    [response?.preview_markdown],
  );

  const canSubmit = useMemo(() => {
    if (phase !== "input" || status !== "connected") {
      return false;
    }
    if (mode === "idea") {
      return text.trim().length > 0;
    }
    if (mode === "journal") {
      return transcript.trim().length > 0 || text.trim().length > 0;
    }
    return ocrText.trim().length > 0 || text.trim().length > 0;
  }, [phase, status, mode, text, transcript, ocrText]);

  const submit = async () => {
    setPhase("submitting");
    setError(null);
    try {
      const client = await getClient();
      let result: CaptureResponse;
      if (mode === "idea") {
        result = await client.captureIdea({ text: text.trim() });
      } else if (mode === "journal") {
        const combined = [transcript, text]
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n\n");
        result = await client.captureJournal({ transcript: combined });
      } else {
        result = await client.capturePerson({
          ocr_result: ocrText.trim(),
          context: text.trim(),
        });
      }
      if (result.status !== "ok") {
        throw new Error(result.error ?? "Unknown error");
      }
      setResponse(result);
      setPhase("preview");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("input");
    }
  };

  const confirmSave = async () => {
    if (!response || !response.filepath) {
      return;
    }
    const title = deriveTitle(response.preview_markdown ?? "");
    await recordCapture({
      id: uuidv4(),
      mode,
      title,
      filepath: response.filepath,
      createdAt: Date.now(),
    });
    setPhase("saved");
    navigation.goBack();
  };

  const promote = async (next: IdeaStatus) => {
    if (!response?.filepath || next === currentStatus) return;
    setError(null);
    try {
      const client = await getClient();
      const updated = await client.promoteIdea(response.filepath, next);
      if (updated.status !== "ok") {
        throw new Error(updated.error ?? "promote failed");
      }
      setResponse(updated);
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
          <HelperText type="info" visible>
            navetted: {status}
          </HelperText>
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
            Claude rédige la note…
          </Text>
        </View>
      )}

      {phase === "preview" && response && (
        <Card style={styles.previewCard}>
          <Card.Title title="Aperçu" subtitle={response.filepath} />
          <Card.Content>
            {mode === "idea" && response.filepath && (
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
            <Text selectable style={styles.previewText}>
              {response.preview_markdown ?? ""}
            </Text>
          </Card.Content>
          <Card.Actions>
            <Button onPress={confirmSave} mode="contained">
              Enregistrer
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
      <TextInput
        label="Ton idée"
        mode="outlined"
        multiline
        numberOfLines={6}
        value={text}
        onChangeText={onTextChange}
        autoFocus
      />
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
  previewText: { fontFamily: "monospace", fontSize: 12, marginTop: 12 },
  statusRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  statusChip: {},
  journalBlock: { gap: 12 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  personBlock: { gap: 12 },
});
