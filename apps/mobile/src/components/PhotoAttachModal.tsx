import { useEffect, useRef, useState } from "react";
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

import { pickAttachment } from "../lib/attachments";
import { useCarnetTheme } from "../lib/theme";

/** Generous headroom over what `quality: 0.6` produces even off a high-megapixel
 * sensor. Checked here, where the bytes actually exist and a rejection can be
 * shown as a normal error — not in the vault writer, which is entered too late. */
const MAX_CAPTURE_BASE64 = 30 * 1024 * 1024;

interface PhotoAttachModalProps {
  visible: boolean;
  onDismiss: () => void;
  /**
   * Bytes in hand, not yet written. `basename` is the picked file's name on the
   * Library path and undefined for a camera shot (which has no user-facing
   * name); the caller's writer defaults it.
   */
  onCaptured: (base64: string, mime: string, basename?: string) => void;
}

/**
 * Camera modal for attaching a photo to a note that is already saved.
 *
 * The Library button routes through `pickAttachment` rather than the vault
 * writer so both sources hand back raw bytes and converge on the caller's ONE
 * guarded write path — a second write path would need its own mtime baseline
 * and would duplicate the concurrent-edit guard.
 */
export function PhotoAttachModal({
  visible,
  onDismiss,
  onCaptured,
}: PhotoAttachModalProps) {
  const theme = useCarnetTheme();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every open so a pick/shot still in flight when the user dismisses
  // can tell it belongs to a dead session and drop its result.
  const sessionRef = useRef(0);

  // The screen renders this component unconditionally and only Paper's Modal
  // internals unmount on close, so component state outlives a close+reopen.
  // Without this a stale "Camera permission denied" (or a latched spinner from
  // an unmount mid-capture) greets the user on a fresh open.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setBusy(false);
    sessionRef.current += 1;
  }, [visible]);

  const capture = async (): Promise<void> => {
    if (!cameraRef.current) {
      setError("Camera not ready — try again in a moment");
      return;
    }
    const session = sessionRef.current;
    setError(null);
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.6,
      });
      if (sessionRef.current !== session) return;
      // Undefined when the user backgrounds the app mid-shoot.
      if (!photo?.base64) {
        throw new Error("No image captured");
      }
      if (photo.base64.length > MAX_CAPTURE_BASE64) {
        throw new Error("Photo is too large to attach — try a lower resolution.");
      }
      onCaptured(photo.base64, "image/jpeg", undefined);
      onDismiss();
    } catch (e: unknown) {
      if (sessionRef.current === session) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  };

  const fromLibrary = async (): Promise<void> => {
    const session = sessionRef.current;
    setError(null);
    setBusy(true);
    try {
      const picked = await pickAttachment({ imagesOnly: true });
      if (sessionRef.current !== session) return;
      if (!picked) return;
      onCaptured(picked.base64, picked.mime, picked.filename);
      onDismiss();
    } catch (e: unknown) {
      if (sessionRef.current === session) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  };

  const grant = async (): Promise<void> => {
    try {
      const result = await requestPermission();
      if (!result.granted) {
        setError("Camera permission denied");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Permission request failed: ${msg}`);
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.modal,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.carnet.radius.sheet,
          },
        ]}
      >
        <View style={styles.header}>
          <Text variant="titleMedium">Attach photo</Text>
          <IconButton icon="close" onPress={onDismiss} accessibilityLabel="Close" />
        </View>

        {/* Only the camera half is permission-gated — the Library path needs no
            camera access, so denying it must not lock out the fallback too. */}
        <View style={styles.body}>
          {!permission ? (
            <ActivityIndicator />
          ) : !permission.granted ? (
            <>
              <Text>Camera permission required.</Text>
              <Button mode="contained" onPress={() => void grant()}>
                Allow camera
              </Button>
            </>
          ) : (
            <>
              <CameraView ref={cameraRef} style={styles.camera} facing="back" />
              <Button
                mode="contained"
                icon="camera"
                onPress={() => void capture()}
                loading={busy}
                disabled={busy}
              >
                Capture
              </Button>
            </>
          )}
          <Button
            icon="image-multiple"
            onPress={() => void fromLibrary()}
            disabled={busy || !permission}
          >
            Library
          </Button>
          {error ? (
            <HelperText type="error" visible>
              {error}
            </HelperText>
          ) : null}
        </View>
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  modal: { margin: 16, padding: 0, overflow: "hidden" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 16,
  },
  body: { padding: 16, gap: 12 },
  camera: {
    aspectRatio: 3 / 4,
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
  },
});
