import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, HelperText, Text } from "react-native-paper";
import * as Clipboard from "expo-clipboard";

import { clearCrashLog, getCrashLog, type CrashRecord } from "../lib/crashLog";
import { spacing } from "../lib/theme";

function formatLog(log: CrashRecord[]): string {
  return log
    .map((c) => {
      const when = new Date(c.timestamp).toISOString();
      const fatal = c.isFatal ? " (fatal)" : "";
      const stack = c.stack ? `\n${c.stack}` : "";
      return `${when}${fatal} — ${c.message}${stack}`;
    })
    .join("\n\n");
}

/**
 * Settings → Diagnostics: view/copy/clear the local crash log (lib/crashLog.ts).
 * There is no remote crash reporting in this app by design — see
 * .claude/PRPs/plans/completed/self-hosted-sentry.plan.md — so this is the
 * only place a crash from a prior session is visible at all.
 */
export function DiagnosticsSection() {
  const [log, setLog] = useState<CrashRecord[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    getCrashLog()
      .then(setLog)
      .catch(() => setLog([]));
  }, []);

  useEffect(() => {
    reload();
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, [reload]);

  const handleCopy = useCallback(() => {
    if (!log || log.length === 0) return;
    setCopyFailed(false);
    Clipboard.setStringAsync(formatLog(log))
      .then(() => {
        setCopied(true);
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => setCopyFailed(true));
  }, [log]);

  const handleClear = useCallback(() => {
    setCopied(false);
    setCopyFailed(false);
    clearCrashLog()
      .then(reload)
      .catch(() => undefined);
  }, [reload]);

  if (log === null) return null;

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={styles.title}>
        Diagnostics
      </Text>
      <HelperText type="info" visible>
        {log.length === 0
          ? "No crashes recorded. Nothing has ever been sent off-device — this is a local log only."
          : `${log.length} crash${log.length === 1 ? "" : "es"} recorded, most recent first. Nothing here is sent off-device.`}
      </HelperText>
      {log.length > 0 && (
        <View style={styles.actions}>
          <Button mode="text" compact onPress={handleCopy}>
            Copy log
          </Button>
          <Button mode="text" compact onPress={handleClear}>
            Clear log
          </Button>
        </View>
      )}
      {copied && (
        <HelperText type="info" visible>
          Copied to clipboard.
        </HelperText>
      )}
      {copyFailed && (
        <HelperText type="error" visible>
          Copy failed.
        </HelperText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  title: { paddingHorizontal: 0, paddingTop: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm },
});
