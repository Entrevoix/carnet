import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Text } from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import { QrScanner, type PairingPayload } from "../components/QrScanner";
import { disconnectClient } from "../lib/client";
import { getSettings, saveSettings } from "../lib/settings";

type Props = NativeStackScreenProps<RootStackParamList, "Pair">;

export default function PairScreen({ navigation }: Props) {
  const [scanning, setScanning] = useState(false);

  const handlePairing = async (payload: PairingPayload) => {
    const url = `${payload.tls ? "wss" : "ws"}://${payload.host}:${payload.port}`;
    const current = await getSettings();
    await saveSettings({
      ...current,
      navettedUrl: url,
      navettedToken: payload.token,
    });
    disconnectClient();
    setScanning(false);
    navigation.replace("Home");
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text variant="headlineMedium">Carnet</Text>
      <Text variant="bodyMedium" style={styles.lead}>
        Pour commencer, scanne le QR code généré par{"\n"}
        <Text style={styles.mono}>navetted --pair</Text>.
      </Text>

      <Button
        mode="contained"
        icon="qrcode-scan"
        onPress={() => setScanning(true)}
        style={styles.scanBtn}
      >
        Scanner le QR
      </Button>

      <View style={styles.altBlock}>
        <Text variant="bodySmall" style={styles.altHint}>
          Pas de QR sous la main ?
        </Text>
        <Button
          mode="text"
          onPress={() => navigation.replace("Settings")}
        >
          Saisir manuellement
        </Button>
      </View>

      <QrScanner
        visible={scanning}
        onPairing={handlePairing}
        onClose={() => setScanning(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 16,
    flexGrow: 1,
    justifyContent: "center",
  },
  lead: { opacity: 0.8, lineHeight: 22 },
  mono: { fontFamily: "monospace" },
  scanBtn: { marginTop: 16 },
  altBlock: { marginTop: 32, alignItems: "center", gap: 4 },
  altHint: { opacity: 0.6 },
});
