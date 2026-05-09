import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, HelperText, Snackbar, Text, TextInput } from "react-native-paper";
import { NavettedClient } from "@carnet/shared";

import {
  getClientId,
  getSettings,
  saveSettings,
  type Settings,
} from "../lib/settings";
import { disconnectClient } from "../lib/client";

interface TestResult {
  ok: boolean;
  msg: string;
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clientId, setClientId] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, id] = await Promise.all([getSettings(), getClientId()]);
      setSettings(s);
      setClientId(id);
    })();
  }, []);

  if (!settings) {
    return (
      <View style={styles.loading}>
        <Text>Chargement…</Text>
      </View>
    );
  }

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
  };

  const save = async () => {
    await saveSettings(settings);
    disconnectClient();
    setSaved(true);
  };

  const testConnection = async () => {
    if (!settings) return;
    setTesting(true);
    setTestResult(null);
    const probe = new NavettedClient({
      url: settings.navettedUrl,
      token: settings.navettedToken,
      clientId,
      requestTimeoutMs: 5_000,
      initialReconnectDelay: 60_000,
      maxReconnectDelay: 60_000,
    });
    probe.connect();
    try {
      // Wait briefly for hello/welcome before pinging.
      const start = Date.now();
      while (probe.getStatus() !== "connected" && Date.now() - start < 5_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (probe.getStatus() !== "connected") {
        throw new Error(`connexion impossible (statut: ${probe.getStatus()})`);
      }
      const { rttMs } = await probe.ping();
      setTestResult({ ok: true, msg: `Connecté en ${rttMs}ms` });
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    } finally {
      probe.disconnect();
      setTesting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <TextInput
        label="navetted URL"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={settings.navettedUrl}
        onChangeText={(v) => update({ navettedUrl: v })}
      />
      <HelperText type="info" visible>
        ws://… ou wss://… (Tailscale ou LAN)
      </HelperText>

      <TextInput
        label="navetted token"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        value={settings.navettedToken}
        onChangeText={(v) => update({ navettedToken: v })}
      />
      <HelperText type="info" visible>
        Token dans ~/.config/navetted/config.toml du poste
      </HelperText>

      <TextInput
        label="OmniRoute URL"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={settings.omniRouteUrl}
        onChangeText={(v) => update({ omniRouteUrl: v })}
      />
      <HelperText type="info" visible>
        Service OCR pour les cartes de visite (optionnel)
      </HelperText>

      <View style={styles.metaRow}>
        <Text variant="labelMedium">Client ID</Text>
        <Text selectable variant="bodySmall" style={styles.mono}>
          {clientId}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Text variant="labelMedium">Sync folder</Text>
        <Text variant="bodySmall" style={styles.mono}>
          configuré côté daemon ([carnet] sync_folder)
        </Text>
      </View>

      <Button
        mode="outlined"
        onPress={testConnection}
        loading={testing}
        disabled={testing}
        style={styles.test}
      >
        Tester la connexion
      </Button>
      {testResult && (
        <HelperText
          type={testResult.ok ? "info" : "error"}
          visible
          style={styles.testResult}
        >
          {testResult.msg}
        </HelperText>
      )}

      <Button mode="contained" onPress={save} style={styles.save}>
        Enregistrer
      </Button>

      <Snackbar
        visible={saved}
        onDismiss={() => setSaved(false)}
        duration={2500}
      >
        Paramètres enregistrés
      </Snackbar>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 4 },
  metaRow: { marginTop: 16, gap: 4 },
  mono: { fontFamily: "monospace" },
  test: { marginTop: 24 },
  testResult: { marginTop: 4 },
  save: { marginTop: 12 },
});
