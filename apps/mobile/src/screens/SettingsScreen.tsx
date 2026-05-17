import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Banner, Button, HelperText, Snackbar, Text, TextInput } from "react-native-paper";

import {
  DEFAULT_OMNIROUTE_MODEL,
  dismissMigrationBanner,
  getSettings,
  hasOmniRouteApiKey,
  saveSettings,
  setOmniRouteApiKey,
  shouldShowMigrationBanner,
  type Settings,
} from "../lib/settings";

interface FormState {
  omniRouteUrl: string;
  omniRouteModel: string;
  captureFolderPath: string;
}

export default function SettingsScreen() {
  const [form, setForm] = useState<FormState | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean>(false);
  /** Holds a NEW API key the user is entering. Empty string means "no change". */
  const [pendingKey, setPendingKey] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, hasKey, banner] = await Promise.all([
        getSettings(),
        hasOmniRouteApiKey(),
        shouldShowMigrationBanner(),
      ]);
      setForm({
        omniRouteUrl: s.omniRouteUrl,
        omniRouteModel: s.omniRouteModel,
        captureFolderPath: s.captureFolderPath,
      });
      setKeyConfigured(hasKey);
      setShowBanner(banner);
    })();
  }, []);

  if (!form) {
    return (
      <View style={styles.loading}>
        <Text>Chargement…</Text>
      </View>
    );
  }

  const update = (patch: Partial<FormState>) => {
    setForm({ ...form, ...patch });
  };

  const save = async () => {
    // Compose a Settings object. The API key is intentionally NOT read into
    // form state — we only write it if the user typed a new one OR cleared it.
    const next: Settings = {
      omniRouteUrl: form.omniRouteUrl,
      omniRouteModel: form.omniRouteModel || DEFAULT_OMNIROUTE_MODEL,
      // Pass an empty string here so saveSettings doesn't touch the key.
      // Then we handle the key write separately below.
      omniRouteApiKey: "",
      captureFolderPath: form.captureFolderPath,
    };
    // Save URL / model / folder via saveSettings, but skip the key write
    // by re-reading the key state inside this scope (we don't have the key
    // in form state). Use setOmniRouteApiKey only when the user typed one.
    await saveSettings({ ...next, omniRouteApiKey: await currentKeyOrEmpty() });
    if (pendingKey.length > 0) {
      await setOmniRouteApiKey(pendingKey);
      setPendingKey("");
      setKeyConfigured(true);
    }
    setSaved(true);
  };

  const clearKey = async () => {
    await setOmniRouteApiKey("");
    setKeyConfigured(false);
    setPendingKey("");
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
        ci-dessous pour continuer à capturer.
      </Banner>

      <TextInput
        label="OmniRoute URL"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={form.omniRouteUrl}
        onChangeText={(v) => update({ omniRouteUrl: v })}
      />
      <HelperText type="info" visible>
        URL de base OmniRoute, doit commencer par https:// (ex: https://llm.grepon.cc)
      </HelperText>

      <TextInput
        label={keyConfigured && pendingKey.length === 0 ? "OmniRoute API key (configurée)" : "OmniRoute API key"}
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder={keyConfigured ? "•••• configurée — tape pour remplacer" : "sk-..."}
        value={pendingKey}
        onChangeText={setPendingKey}
      />
      <HelperText type="info" visible>
        Stockée dans le trousseau sécurisé. La clé existante n'est jamais ré-affichée.
      </HelperText>
      {keyConfigured && (
        <Button mode="text" compact onPress={clearKey} style={styles.clearKey}>
          Effacer la clé
        </Button>
      )}

      <TextInput
        label="Modèle"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={form.omniRouteModel}
        onChangeText={(v) => update({ omniRouteModel: v })}
        placeholder={DEFAULT_OMNIROUTE_MODEL}
      />
      <HelperText type="info" visible>
        Modèle OmniRoute (ex: gpt-4o-mini, claude-sonnet-4, gemini-1.5-pro)
      </HelperText>

      <TextInput
        label="Dossier de capture"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={form.captureFolderPath}
        onChangeText={(v) => update({ captureFolderPath: v })}
        placeholder="(dossier sandbox par défaut)"
      />
      <HelperText type="info" visible>
        Chemin du dossier Syncthing sur Android (ex: /storage/emulated/0/carnet)
      </HelperText>

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

/** Helper that returns the currently-stored API key if present (so
 * saveSettings doesn't wipe it when the user only changed URL/model). */
async function currentKeyOrEmpty(): Promise<string> {
  const s = await getSettings();
  return s.omniRouteApiKey ?? "";
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 4 },
  save: { marginTop: 12 },
  clearKey: { alignSelf: "flex-start", marginTop: 4 },
});
