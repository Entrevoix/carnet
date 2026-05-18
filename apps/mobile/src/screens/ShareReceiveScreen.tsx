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
  Banner,
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
import { extFromMime, writeBinary, writeIdea, slugify } from "../lib/writer";
import { enrichSharedImage, enrichSharedLink } from "../lib/omniroute";
import { deriveTitle } from "@carnet/shared";

const { StorageAccessFramework } = FileSystem;

/** Hard cap on shared image size. Vision models reject >10 MB payloads and
 * keeping the base64 in JS memory on a phone past ~8 MB is dangerous (the
 * data: URL inflates by 33%, then JSON.stringify duplicates it for the
 * request body). Surface a helpful error rather than OOM the app. */
const MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024;

type Props = NativeStackScreenProps<RootStackParamList, "ShareReceive">;

type Phase = "input" | "saving" | "saved";

/** YYYYMMDD-HHMMSS local-time stamp used as the slug for shared captures. */
function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  /** Surfaced as a banner on the saved screen when AI enrichment failed and
   * we fell back to a stub note. Carries the sanitized error message so the
   * user can see auth / model issues they can act on. */
  const [degradedReason, setDegradedReason] = useState<string | null>(null);

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
    setDegradedReason(null);
    setPhase("saving");
    try {
      const slugFallback = timestampSlug();
      const files = shareIntent.files ?? [];
      const text = shareIntent.text ?? "";
      const url = shareIntent.webUrl ?? "";
      const ctx = combinedContext;

      const imageFile = files.find((f) => f.mimeType?.startsWith("image/"));

      let filepath: string;
      let title: string;
      const mode: "idea" = "idea";

      if (imageFile) {
        // Cap up-front: vision models reject large payloads and the in-memory
        // peak (base64 + JSON-encoded data URL) can OOM the phone.
        if (imageFile.size && imageFile.size > MAX_SHARED_IMAGE_BYTES) {
          const mb = Math.round(imageFile.size / 1024 / 1024);
          throw new Error(
            `Image is ${mb} MB — carnet caps shares at ${Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024)} MB. Downscale or crop before sharing.`,
          );
        }
        const mime = imageFile.mimeType ?? "image/jpeg";

        // Some share sources hand carnet a `content://` URI (Photos via
        // FileProvider, etc.) — read accordingly. file:// goes through the
        // legacy FileSystem API; content:// goes through SAF.
        let base64: string;
        if (imageFile.path.startsWith("content://")) {
          base64 = await StorageAccessFramework.readAsStringAsync(imageFile.path, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } else {
          base64 = await FileSystem.readAsStringAsync(imageFile.path, {
            encoding: FileSystem.EncodingType.Base64,
          });
        }

        // Vision enrichment. If it fails (auth, missing key, wrong model,
        // offline), surface the reason via a degraded-banner on the saved
        // screen — still save a stub so the share isn't dropped, but never
        // silently.
        let enrichedMd: string;
        try {
          const result = await enrichSharedImage({ base64, mimeType: mime, context: ctx });
          enrichedMd = result.markdown;
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn("[ShareReceive] vision enrichment failed:", reason);
          setDegradedReason(reason);
          enrichedMd = `---\ncreated: ${new Date().toISOString()}\nkind: shared-image\ntags: [shared, image]\n---\n# Shared image ${slugFallback}\n\n## What's in this\n(Vision enrichment unavailable — see image.)\n\n## Context\n${ctx || "(none provided)"}`;
        }

        title = deriveTitle(enrichedMd) || `Shared image ${slugFallback}`;
        const desiredSlug = slugify(title) || `shared-image-${slugFallback}`;

        const ext = extFromMime(mime);
        const { finalName } = await writeBinary("Photos", `${desiredSlug}.${ext}`, base64, mime);

        // Share the collision-bumped stem so .jpg and .md stay paired. If
        // writeBinary returned `foo-3.jpg`, the .md is forced to start from
        // `foo-3` (Ideas/ may still collide independently and bump further,
        // but the link to the photo is preserved correctly).
        const sharedStem = finalName.replace(/\.[^.]+$/, "");
        const withImage = enrichedMd.replace(
          /^(#\s+.+\n)/m,
          `$1\n![](../Photos/${finalName})\n`,
        );
        const { filepath: mdPath } = await writeIdea(sharedStem, withImage);
        filepath = mdPath;
      } else if (url || text) {
        // URL/text share: text-only enrichment.
        let enrichedMd: string;
        try {
          const result = await enrichSharedLink({ url, text, context: ctx });
          enrichedMd = result.markdown;
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn("[ShareReceive] link enrichment failed:", reason);
          setDegradedReason(reason);
          const head = url ? "Shared link" : "Shared text";
          enrichedMd = `---\ncreated: ${new Date().toISOString()}\nkind: ${url ? "shared-link" : "shared-text"}\ntags: [shared]\n---\n# ${head} ${slugFallback}\n\n${url ? `## Source\n<${url}>\n\n` : ""}${text && text !== url ? `## Excerpt\n${text}\n\n` : ""}## Context\n${ctx || "(none provided)"}`;
        }

        title = deriveTitle(enrichedMd) || (url ? `Shared link ${slugFallback}` : `Shared text ${slugFallback}`);
        const slug = slugify(title) || `shared-${slugFallback}`;
        const { filepath: mdPath } = await writeIdea(slug, enrichedMd);
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
      setSavedFilepath(filepath);
      setPhase("saved");
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
          <Text variant="bodyMedium" style={styles.dim}>
            OmniRoute is enriching + saving…
          </Text>
        </View>
      ) : phase === "saved" ? (
        <Card style={styles.card}>
          <Card.Title title="Saved to vault" />
          <Card.Content>
            {degradedReason ? (
              <Banner visible icon="alert" actions={[]} style={styles.degradedBanner}>
                {`AI enrichment failed — saved as a stub note. ${degradedReason}`}
              </Banner>
            ) : null}
            <Text variant="bodySmall" selectable style={styles.body}>
              {savedFilepath ?? "(no path)"}
            </Text>
            <HelperText type="info" visible>
              Open Obsidian (or your editor) on the synced folder to read
              and edit. Carnet is intake-only.
            </HelperText>
          </Card.Content>
          <Card.Actions>
            <Button
              mode="contained"
              onPress={() => {
                resetShareIntent();
                navigation.goBack();
              }}
            >
              Done
            </Button>
          </Card.Actions>
        </Card>
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
  degradedBanner: { marginBottom: 8 },
});
