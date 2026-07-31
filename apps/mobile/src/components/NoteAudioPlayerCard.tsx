import { StyleSheet, View } from "react-native";
import { Card, IconButton, ProgressBar, Text } from "react-native-paper";

import { formatElapsed } from "../lib/shareHelpers";
import type { CarnetTheme } from "../lib/theme";

interface NoteAudioPlayerCardProps {
  theme: CarnetTheme;
  isPlaying: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  error: string | null;
  disabled: boolean;
  onTogglePlay: () => void;
}

/**
 * Inline player for a note with a paired recording. Shown for the same audio
 * notes the Transcribe action covers; the duration only appears once the sound
 * has loaded and reported a status frame.
 */
export function NoteAudioPlayerCard({
  theme,
  isPlaying,
  loading,
  positionMs,
  durationMs,
  error,
  disabled,
  onTogglePlay,
}: NoteAudioPlayerCardProps) {
  return (
    <Card style={styles.card}>
      <Card.Content>
        <View style={styles.playerRow}>
          <IconButton
            icon={isPlaying ? "pause" : "play"}
            mode="contained"
            size={28}
            onPress={onTogglePlay}
            disabled={disabled}
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
          />
          <View style={styles.playerMeta}>
            <Text variant="bodySmall" style={styles.playerTime}>
              {durationMs > 0
                ? `${formatElapsed(positionMs)} / ${formatElapsed(durationMs)}`
                : loading
                  ? "Loading…"
                  : "Audio note — tap play"}
            </Text>
            <ProgressBar
              progress={durationMs > 0 ? positionMs / durationMs : 0}
              style={styles.playerProgress}
            />
          </View>
        </View>
        {error ? (
          <Text
            variant="bodySmall"
            style={[styles.playerError, { color: theme.colors.error }]}
          >
            {`Playback failed: ${error}`}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 4 },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  playerMeta: { flex: 1, gap: 4 },
  playerTime: { opacity: 0.7, fontVariant: ["tabular-nums"] },
  playerProgress: { height: 4, borderRadius: 2 },
  // color comes from the theme at the usage site (colors.error).
  playerError: { marginTop: 8 },
});
