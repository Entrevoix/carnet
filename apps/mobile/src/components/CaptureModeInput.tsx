import { useState, type Ref } from "react";
import { StyleSheet, View } from "react-native";
import { Button, HelperText, Text, TextInput } from "react-native-paper";

import { VoiceButton, type VoiceButtonHandle } from "../voice/VoiceButton";
import { CardScannerModal } from "./CardScannerModal";
import { getSettings } from "../lib/settings";
import type { CaptureMode } from "../lib/storage";
import { caretProps, useCarnetTheme } from "../lib/theme";

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

/** The distraction-free writing surface for each capture mode. Pure
 * presentational: all state (text/transcript/ocr) is owned by CaptureScreen
 * and threaded in — this component only renders inputs and forwards changes. */
export function ModeInput({
  mode,
  text,
  onTextChange,
  transcript,
  onTranscriptChange,
  ocrText,
  onOcrChange,
  voiceRef,
}: ModeInputProps) {
  const theme = useCarnetTheme();
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
          {...caretProps(theme)}
          placeholder="What's on your mind?"
          mode="flat"
          multiline
          numberOfLines={8}
          value={text}
          onChangeText={onTextChange}
          autoFocus
          underlineColor="transparent"
          activeUnderlineColor="transparent"
          style={styles.fullBleedInput}
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
          {...caretProps(theme)}
          placeholder="Transcript — speak or type"
          mode="flat"
          multiline
          numberOfLines={6}
          value={transcript}
          onChangeText={onTranscriptChange}
          autoFocus
          underlineColor="transparent"
          activeUnderlineColor="transparent"
          style={styles.fullBleedInput}
        />
        <TextInput
          {...caretProps(theme)}
          placeholder="Additional notes"
          mode="flat"
          multiline
          numberOfLines={3}
          value={text}
          onChangeText={onTextChange}
          underlineColor="transparent"
          activeUnderlineColor="transparent"
          style={styles.fullBleedInputSecondary}
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
  const theme = useCarnetTheme();
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
        {...caretProps(theme)}
        placeholder="Card text — scan or type"
        mode="flat"
        multiline
        numberOfLines={4}
        value={ocrText}
        onChangeText={onOcrChange}
        autoFocus
        underlineColor="transparent"
        activeUnderlineColor="transparent"
        style={styles.fullBleedInput}
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
        {...caretProps(theme)}
        placeholder="Meeting context"
        mode="flat"
        multiline
        numberOfLines={3}
        value={context}
        onChangeText={onContextChange}
        underlineColor="transparent"
        activeUnderlineColor="transparent"
        style={styles.fullBleedInputSecondary}
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
  // Distraction-free writing surface: no card, no outline, no underline —
  // the text sits directly on the screen background.
  fullBleedInput: { backgroundColor: "transparent", fontSize: 18, paddingHorizontal: 0 },
  fullBleedInputSecondary: { backgroundColor: "transparent", paddingHorizontal: 0 },
  ideaBlock: { gap: 12 },
  journalBlock: { gap: 12 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  personBlock: { gap: 12 },
  wordCounter: { opacity: 0.5, marginTop: 4, textAlign: "right" },
});
