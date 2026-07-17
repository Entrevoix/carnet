import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  HelperText,
  IconButton,
  Modal,
  Portal,
  Text,
} from "react-native-paper";
import { CameraView, useCameraPermissions } from "expo-camera";

import { ocrCardViaVision } from "../lib/dispatcher";

interface Props {
  visible: boolean;
  onResult: (text: string) => void;
  onClose: () => void;
}

export function CardScannerModal({ visible, onResult, onClose }: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capture = async () => {
    if (!cameraRef.current) return;
    setError(null);
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.6,
      });
      if (!photo?.base64) {
        throw new Error("no image captured");
      }
      const { text } = await ocrCardViaVision({
        base64: photo.base64,
        mimeType: "image/jpeg",
      });
      onResult(text);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    const result = await requestPermission();
    if (!result.granted) {
      setError("Camera permission denied");
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onClose}
        contentContainerStyle={styles.modal}
      >
        <View style={styles.header}>
          <Text variant="titleMedium">Scan card</Text>
          <IconButton
            icon="close"
            onPress={onClose}
            accessibilityLabel="Close and enter manually"
          />
        </View>

        {!permission ? (
          <View style={styles.body}>
            <ActivityIndicator />
          </View>
        ) : !permission.granted ? (
          <View style={styles.body}>
            <Text>Camera permission required.</Text>
            <Button mode="contained" onPress={grant} style={styles.grantBtn}>
              Allow camera
            </Button>
          </View>
        ) : (
          <View style={styles.body}>
            <CameraView ref={cameraRef} style={styles.camera} facing="back" />
            <Button
              mode="contained"
              icon="camera"
              onPress={capture}
              loading={busy}
              disabled={busy}
              style={styles.captureBtn}
            >
              Capture
            </Button>
            {busy && (
              <HelperText type="info" visible>
                OCR in progress…
              </HelperText>
            )}
            {error && (
              <HelperText type="error" visible>
                {error}
              </HelperText>
            )}
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
    padding: 0,
    borderRadius: 12,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 16,
  },
  body: {
    padding: 16,
    gap: 12,
  },
  camera: {
    aspectRatio: 3 / 4,
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
  },
  captureBtn: {},
  grantBtn: {
    marginTop: 12,
  },
});
