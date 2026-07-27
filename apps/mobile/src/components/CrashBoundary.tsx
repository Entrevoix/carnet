import { Component, type ErrorInfo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "react-native-paper";

import { recordCrash } from "../lib/crashLog";
import { spacing, useCarnetTheme } from "../lib/theme";

interface CrashBoundaryProps {
  children: ReactNode;
}

interface CrashBoundaryState {
  error: Error | null;
}

/**
 * Themed fallback UI, split out as a function component so it can use
 * useCarnetTheme() — React error boundaries must be classes, and hooks
 * don't work in classes.
 */
function CrashFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const { colors } = useCarnetTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.onSurface }]}>
        Something went wrong
      </Text>
      <Text style={[styles.message, { color: colors.onSurfaceVariant }]}>
        {error.message}
      </Text>
      <Text style={[styles.hint, { color: colors.onSurfaceVariant }]}>
        The error was saved to Settings → Diagnostics. Your notes are safe — nothing is
        written to the vault by this screen.
      </Text>
      <Button mode="contained" onPress={onReset} style={styles.button}>
        Try again
      </Button>
    </View>
  );
}

/**
 * Catches render-phase errors that would otherwise take down the whole app
 * with a native "keeps stopping" crash (the exact failure mode this project
 * has hit before — see expo-share-intent+5.1.1.patch's crash loop). Logs
 * via lib/crashLog.ts so the crash survives past this session, then offers
 * a "Try again" reset instead of forcing a full app restart.
 *
 * React error boundaries must be class components — there is no hooks
 * equivalent for componentDidCatch/getDerivedStateFromError.
 */
export class CrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  state: CrashBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CrashBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordCrash(error, { isFatal: false }).catch(() => undefined);
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.error("[CrashBoundary]", error, info.componentStack);
    }
  }

  handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return <CrashFallback error={this.state.error} onReset={this.handleReset} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: spacing.md,
  },
  message: {
    fontSize: 14,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  hint: {
    fontSize: 12,
    textAlign: "center",
    marginBottom: spacing.lg,
  },
  button: {
    marginTop: spacing.sm,
  },
});
