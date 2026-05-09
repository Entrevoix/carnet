import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  HelperText,
  Text,
  Portal,
  Modal,
  ActivityIndicator,
} from "react-native-paper";
import { CameraView, useCameraPermissions } from "expo-camera";

export interface PairingPayload {
  host: string;
  port: string;
  token: string;
  tls: boolean;
}

interface Props {
  visible: boolean;
  onPairing: (payload: PairingPayload) => void;
  onClose: () => void;
}

const PREFIX = "navette://";

export function QrScanner({ visible, onPairing, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const scannedRef = useRef(false);

  const handleScan = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      if (!data.startsWith(PREFIX)) {
        setError("Code QR non reconnu (préfixe manquant).");
        scannedRef.current = false;
        return;
      }
      const encoded = data.slice(PREFIX.length);
      const decoded = atob(encoded);
      const parsed = JSON.parse(decoded) as Partial<PairingPayload>;
      if (!parsed.host || !parsed.port || !parsed.token) {
        setError("Champs manquants dans le code QR.");
        scannedRef.current = false;
        return;
      }
      onPairing({
        host: parsed.host,
        port: parsed.port,
        token: parsed.token,
        tls: parsed.tls ?? false,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      scannedRef.current = false;
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onClose}
        contentContainerStyle={styles.modal}
      >
        {!permission ? (
          <ActivityIndicator />
        ) : !permission.granted ? (
          <View style={styles.body}>
            <Text>Autorisation caméra requise pour scanner.</Text>
            <Button mode="contained" onPress={() => void requestPermission()}>
              Autoriser
            </Button>
          </View>
        ) : (
          <View style={styles.body}>
            <Text variant="titleMedium">Scanne le QR de navetted</Text>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={handleScan}
            />
            {error && (
              <HelperText type="error" visible>
                {error}
              </HelperText>
            )}
            <Button onPress={onClose}>Annuler</Button>
          </View>
        )}
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  modal: {
    backgroundColor: "white",
    margin: 16,
    padding: 16,
    borderRadius: 12,
  },
  body: { gap: 12 },
  camera: {
    aspectRatio: 1,
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
  },
});
