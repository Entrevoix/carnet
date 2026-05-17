/**
 * Receiver screen for "Share to carnet" intents (Android share sheet).
 *
 * Phase 2: accepts a context note (text + voice) and saves the shared
 * payload to the vault.
 *   - Image share → binary written to Photos/{slug}.{ext} + a markdown
 *     note Photos/{slug}.md that references the image and embeds the
 *     user's context.
 *   - URL / text share → markdown note in Ideas/{slug}.md with the
 *     shared content + context.
 *
 * No OmniRoute vision/enrichment yet — that's phase 3. Raw save first
 * so the offline path is solid before we layer LLM calls on top.
 */

import { useEffect, useMemo, useState } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Card,
  HelperText,
  Text,
  TextInput,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useShareIntentContext } from "expo-share-intent";
import * as FileSystem from "expo-file-system/legacy";

import type { RootStackParamList } from "../../App";
import { VoiceButton } from "../voice/VoiceButton";
import { recordCapture } from "../lib/storage";
import { writeBinary, writeIdea, slugify } from "../lib/writer";

type Props = NativeStackScreenProps<RootStackParamList, "ShareReceive">;

type Phase = "input" | "saving" | "saved";

/** YYYYMMDD-HHMMSS local-time stamp used as the slug for shared captures. */
function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Best-effort extension from a mime type — falls back to bin. */
function extFromMime(mime?: string): string {
  if (!mime) return "bin";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/heic") return "heic";
  const slash = mime.indexOf("/");
  return slash >= 0 ? mime.slice(slash + 1) : "bin";
}

/** Generate non-crypto local id for the recents history. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ShareReceiveScreen({ navigation }: Props) {
  const { shareIntent, resetShareIntent } = useShareIntentContext();

  // If the screen ever opens without a shareIntent (deep link mishap), bail.
  useEffect(() => {
    if (!shareIntent) {
      navigation.goBack();
    }
  }, [shareIntent, navigation]);

  const [context, setContext] = useState("");
  const [transcript, setTranscript] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [error, setError] = useState<string | null>(null);

  /** Combined text from typed context + accepted voice transcript. */
  const combinedContext = useMemo(() => {
    const parts = [context, transcript].map((s) => s.trim()).filter(Boolean);
    return parts.join("\n\n");
  }, [context, transcript]);

  const cancel = () => {
    resetShareIntent();
    navigation.goBack();
  };

  const save = async () => {
    if (!shareIntent) return;
    setError(null);
    setPhase("saving");
    try {
      const slug = timestampSlug();
      const files = shareIntent.files ?? [];
      const text = shareIntent.text ?? "";
      const url = shareIntent.webUrl ?? "";
      const ctx = combinedContext;

      const imageFile = files.find((f) => f.mimeType?.startsWith("image/"));

      let filepath: string;
      let title: string;
      let mode: "idea" = "idea";

      if (imageFile) {
        // Image share: copy binary into vault, then write a markdown stub.
        const base64 = await FileSystem.readAsStringAsync(imageFile.path, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const ext = extFromMime(imageFile.mimeType);
        const sourceName = imageFile.fileName?.replace(/[^a-zA-Z0-9._-]/g, "-") ?? `${slug}.${ext}`;
        const binFilename = sourceName.includes(".") ? sourceName : `${sourceName}.${ext}`;
        const { finalName } = await writeBinary(
          "Photos",
          binFilename,
          base64,
          imageFile.mimeType ?? "application/octet-stream",
        );
        title = `Shared image ${slug}`;
        const md = [
          `---`,
          `title: ${title}`,
          `kind: shared-image`,
          `source: ${imageFile.fileName ?? "(unknown)"}`,
          `mime: ${imageFile.mimeType ?? "?"}`,
          `created: ${new Date().toISOString()}`,
          `---`,
          ``,
          `# ${title}`,
          ``,
          `![](./${finalName})`,
          ``,
          ctx ? `## Context\n\n${ctx}\n` : "",
        ]
          .filter((line) => line !== "")
          .join("\n");
        // Save the markdown stub via writeIdea-equivalent path under Photos/.
        // Reuse writeBinary just for collision-safe placement of the .md file.
        // (Markdown is utf-8 text; writeBinary writes raw bytes, which would
        // mangle the encoding. So instead we use the public writeIdea API
        // and accept that the .md lands in Ideas/ rather than next to the
        // photo. The frontmatter `kind: shared-image` is the cross-reference.)
        const { filepath: mdPath } = await writeIdea(`${slugify(title)}`, md);
        filepath = mdPath;
      } else if (url || text) {
        // URL/text share → idea-shaped markdown note.
        const head = url ? `Shared link` : `Shared text`;
        title = `${head} ${slug}`;
        const md = [
          `---`,
          `title: ${title}`,
          `kind: ${url ? "shared-link" : "shared-text"}`,
          `created: ${new Date().toISOString()}`,
          `---`,
          ``,
          `# ${title}`,
          ``,
          url ? `<${url}>` : "",
          text && text !== url ? `\n${text}\n` : "",
          ctx ? `\n## Context\n\n${ctx}\n` : "",
        ]
          .filter((line) => line !== "")
          .join("\n");
        const { filepath: mdPath } = await writeIdea(slugify(title), md);
        filepath = mdPath;
      } else {
        throw new Error("Nothing to save — empty share payload");
      }

      await recordCapture({
        id: localId(),
        mode,
        title,
        filepath,
        createdAt: Date.now(),
      });
      setPhase("saved");
      resetShareIntent();
      navigation.goBack();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[ShareReceive] save failed:", msg, e);
      setError(msg);
      setPhase("input");
    }
  };

  if (!shareIntent) return null;

  const files = shareIntent.files ?? [];
  const text = shareIntent.text ?? "";
  const url = shareIntent.webUrl ?? "";

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <Card.Title title="Shared with carnet" />
        <Card.Content>
          {url ? (
            <View style={styles.section}>
              <Text variant="labelMedium">URL</Text>
              <Text selectable style={styles.body}>{url}</Text>
            </View>
          ) : null}

          {text && text !== url ? (
            <View style={styles.section}>
              <Text variant="labelMedium">Text</Text>
              <Text selectable style={styles.body}>{text}</Text>
            </View>
          ) : null}

          {files.length > 0 ? (
            <View style={styles.section}>
              <Text variant="labelMedium">Files ({files.length})</Text>
              {files.map((f, i) => (
                <View key={`${f.path}-${i}`} style={styles.fileRow}>
                  {f.mimeType?.startsWith("image/") ? (
                    <Image source={{ uri: f.path }} style={styles.thumb} />
                  ) : null}
                  <View style={styles.fileMeta}>
                    <Text variant="bodySmall">{f.fileName ?? f.path}</Text>
                    <Text variant="bodySmall" style={styles.dim}>
                      {f.mimeType ?? "?"} • {f.size ? `${Math.round(f.size / 1024)} KB` : "?"}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </Card.Content>
      </Card>

      <Card style={styles.card}>
        <Card.Title title="Add context" subtitle="Optional — what is this about?" />
        <Card.Content style={styles.section}>
          <View style={styles.voiceRow}>
            <VoiceButton
              onTranscript={(t, isFinal) => {
                if (isFinal) {
                  setTranscript((prev) => (prev ? `${prev}\n${t}`.trim() : t));
                }
              }}
            />
            <Text variant="bodySmall" style={styles.voiceHint}>
              Tap to dictate
            </Text>
          </View>
          {transcript ? (
            <TextInput
              label="Transcript"
              mode="outlined"
              multiline
              numberOfLines={3}
              value={transcript}
              onChangeText={setTranscript}
            />
          ) : null}
          <TextInput
            label="Notes"
            mode="outlined"
            multiline
            numberOfLines={4}
            value={context}
            onChangeText={setContext}
            placeholder="Type any extra context here"
          />
        </Card.Content>
      </Card>

      {phase === "saving" ? (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={styles.dim}>Saving to vault…</Text>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button mode="text" onPress={cancel}>
            Cancel
          </Button>
          <Button mode="contained" onPress={save}>
            Save to vault
          </Button>
        </View>
      )}

      {error ? (
        <HelperText type="error" visible style={styles.errMsg}>
          {error}
        </HelperText>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { marginTop: 4 },
  section: { marginTop: 12, gap: 8 },
  body: { fontSize: 14, lineHeight: 20 },
  dim: { opacity: 0.6 },
  fileRow: { flexDirection: "row", gap: 12, alignItems: "center", marginTop: 8 },
  thumb: { width: 64, height: 64, borderRadius: 6, backgroundColor: "#0001" },
  fileMeta: { flex: 1, gap: 2 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  loading: { paddingVertical: 32, alignItems: "center", gap: 8 },
  errMsg: { textAlign: "center" },
});
