import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Banner, Button, HelperText, Snackbar, Text, TextInput } from "react-native-paper";

import {
  getClientId,
  getSettings,
  saveSettings,
  shouldShowMigrationBanner,
  dismissMigrationBanner,
  type Settings,
} from "../lib/settings";

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clientId, setClientId] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, id, banner] = await Promise.all([
        getSettings(),
        getClientId(),
        shouldShowMigrationBanner(),
      ]);
      setSettings(s);
      setClientId(id);
      setShowBanner(banner);
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
    setSaved(true);
  };

  const handleDismissBanner = async () => {
    await dismissMigrationBanner();
    setShowBanner(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Banner
        visible={showBanner}
        actions={[
          {
            label: "OK, compris",
            onPress: handleDismissBanner,
          },
        ]}
        icon="information"
      >
        navetted a été remplacé par OmniRoute. Configure ta clé OmniRoute
        ci-dessous et active le mode expérimental pour continuer à capturer.
      </Banner>

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
        URL de base OmniRoute (ex: https://llm.grepon.cc)
      </HelperText>

      <TextInput
        label="OmniRoute API key"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        value={settings.omniRouteApiKey}
        onChangeText={(v) => update({ omniRouteApiKey: v })}
      />
      <HelperText type="info" visible>
        Clé API OmniRoute (stockée dans le trousseau sécurisé)
      </HelperText>

      <TextInput
        label="Dossier de capture"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={settings.captureFolderPath}
        onChangeText={(v) => update({ captureFolderPath: v })}
        placeholder="(dossier sandbox par défaut)"
      />
      <HelperText type="info" visible>
        Chemin du dossier Syncthing sur Android (ex: /storage/emulated/0/carnet)
      </HelperText>

      <View style={styles.metaRow}>
        <Text variant="labelMedium">Client ID</Text>
        <Text selectable variant="bodySmall" style={styles.mono}>
          {clientId}
        </Text>
      </View>

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
  save: { marginTop: 12 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
    paddingVertical: 4,
  },
  switchLabel: { flex: 1, marginRight: 16 },
  switchHint: { opacity: 0.6, marginTop: 2 },
});
