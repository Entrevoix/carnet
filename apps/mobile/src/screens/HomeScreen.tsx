import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Divider,
  IconButton,
  List,
  Text,
  useTheme,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import { getRecentCaptures, type CaptureEntry } from "../lib/storage";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export default function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const [recent, setRecent] = useState<CaptureEntry[]>([]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon="cog"
          onPress={() => navigation.navigate("Settings")}
        />
      ),
    });
  }, [navigation]);

  const refresh = useCallback(async () => {
    const items = await getRecentCaptures();
    setRecent(items);
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", () => {
      void refresh();
    });
    void refresh();
    return unsubscribe;
  }, [navigation, refresh]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Button
        mode="contained"
        icon="lightbulb-on"
        onPress={() => navigation.navigate("Capture", { mode: "idea" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Idea
      </Button>
      <Button
        mode="contained-tonal"
        icon="microphone"
        onPress={() => navigation.navigate("Capture", { mode: "journal" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Journal
      </Button>
      <Button
        mode="outlined"
        icon="account-plus"
        onPress={() => navigation.navigate("Capture", { mode: "person" })}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Contact
      </Button>
      <Button
        mode="outlined"
        icon="camera"
        onPress={() => navigation.navigate("PhotoCapture")}
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        Photo
      </Button>

      {/* "Continue today's journal" shortcut — skips mode selection */}
      <Button
        mode="text"
        icon="book-open-variant"
        onPress={() => navigation.navigate("Capture", { mode: "journal" })}
        style={styles.journalShortcut}
        compact
      >
        Continue today's journal
      </Button>

      <Divider style={styles.divider} />

      {/* Last 5 captures card */}
      <Card style={styles.recentCard}>
        <Card.Title title="Recent" />
        <Card.Content>
          {recent.length === 0 ? (
            <Text variant="bodyMedium" style={styles.emptyHint}>
              No captures yet.
            </Text>
          ) : (
            <View>
              {recent.map((item) => (
                <List.Item
                  key={item.id}
                  title={item.title}
                  description={`${formatMode(item.mode)} • ${formatDate(item.createdAt)}`}
                  left={(p) => (
                    <List.Icon {...p} icon={modeIcon(item.mode)} />
                  )}
                  style={styles.listItem}
                />
              ))}
            </View>
          )}
        </Card.Content>
      </Card>
    </ScrollView>
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
  }
}

function modeIcon(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea":
      return "lightbulb-on";
    case "journal":
      return "microphone";
    case "person":
      return "account";
    case "photo":
      return "camera";
  }
}

function formatDate(unix: number): string {
  const d = new Date(unix);
  return d.toLocaleString();
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, gap: 12 },
  button: { borderRadius: 12 },
  buttonContent: { paddingVertical: 16 },
  buttonLabel: { fontSize: 18 },
  journalShortcut: { alignSelf: "flex-start" },
  divider: { marginVertical: 8 },
  recentCard: { marginTop: 4 },
  emptyHint: { opacity: 0.6, paddingVertical: 8 },
  listItem: { paddingHorizontal: 0 },
});
