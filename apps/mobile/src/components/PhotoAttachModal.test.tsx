// @vitest-environment jsdom
//
// Smoke test for the view-mode camera modal (pattern: see PlacesEditor.test.tsx).
// expo-camera is a native module — stubbed here so the permission gate and the
// capture/library dispatch can be exercised in jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

const takePictureAsync = vi.fn();
const requestPermission = vi.fn();
let permission: { granted: boolean } | null = { granted: true };

vi.mock("expo-camera", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const { View } = await import("react-native");
  return {
    CameraView: forwardRef((_props: Record<string, unknown>, ref: unknown) => {
      useImperativeHandle(ref as never, () => ({ takePictureAsync }));
      return <View testID="camera-view" />;
    }),
    useCameraPermissions: () => [permission, requestPermission] as const,
  };
});

vi.mock("../lib/attachments", () => ({ pickAttachment: vi.fn() }));

import { PhotoAttachModal } from "./PhotoAttachModal";
import { pickAttachment } from "../lib/attachments";
import { carnetLight } from "../lib/theme";

const mockPick = vi.mocked(pickAttachment);

function renderModal(overrides?: {
  onCaptured?: (base64: string, mime: string, basename?: string) => void;
  onDismiss?: () => void;
}) {
  const onCaptured = overrides?.onCaptured ?? vi.fn();
  const onDismiss = overrides?.onDismiss ?? vi.fn();
  const { rerender } = render(
    <PaperProvider theme={carnetLight}>
      <PhotoAttachModal visible onDismiss={onDismiss} onCaptured={onCaptured} />
    </PaperProvider>,
  );
  /** Drive the `visible` prop the way the screen does — the component itself
   * stays mounted across a close+reopen. */
  const setVisible = (visible: boolean) =>
    rerender(
      <PaperProvider theme={carnetLight}>
        <PhotoAttachModal
          visible={visible}
          onDismiss={onDismiss}
          onCaptured={onCaptured}
        />
      </PaperProvider>,
    );
  return { onCaptured, onDismiss, setVisible };
}

beforeEach(() => {
  vi.clearAllMocks();
  permission = { granted: true };
});

afterEach(cleanup);

describe("PhotoAttachModal", () => {
  it("renders the permission gate and mounts no camera when access is denied", () => {
    permission = { granted: false };
    renderModal();
    expect(screen.getByText("Camera permission required.")).toBeTruthy();
    expect(screen.getByText("Allow camera")).toBeTruthy();
    expect(screen.queryByTestId("camera-view")).toBeNull();
  });

  it("mounts the camera once permission is granted", () => {
    renderModal();
    expect(screen.getByTestId("camera-view")).toBeTruthy();
    expect(screen.queryByText("Camera permission required.")).toBeNull();
  });

  it("hands the shutter's bytes to onCaptured and closes", async () => {
    takePictureAsync.mockResolvedValue({ base64: "AAAA", uri: "file:///t.jpg" });
    const { onCaptured, onDismiss } = renderModal();

    fireEvent.click(screen.getByText("Capture"));

    await waitFor(() =>
      expect(onCaptured).toHaveBeenCalledWith("AAAA", "image/jpeg", undefined),
    );
    expect(takePictureAsync).toHaveBeenCalledWith({ base64: true, quality: 0.6 });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("surfaces an error and stays open when the shot returns no bytes", async () => {
    // Backgrounding the app mid-shoot resolves without base64.
    takePictureAsync.mockResolvedValue({ uri: "file:///t.jpg" });
    const { onCaptured, onDismiss } = renderModal();

    fireEvent.click(screen.getByText("Capture"));

    expect(await screen.findByText("No image captured")).toBeTruthy();
    expect(onCaptured).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("routes the Library fallback through the same onCaptured contract", async () => {
    mockPick.mockResolvedValue({
      base64: "BBBB",
      mime: "image/png",
      filename: "shot.png",
      kind: "image",
    });
    const { onCaptured } = renderModal();

    fireEvent.click(screen.getByText("Library"));

    await waitFor(() =>
      expect(onCaptured).toHaveBeenCalledWith("BBBB", "image/png", "shot.png"),
    );
  });

  it("does nothing when the library pick is cancelled", async () => {
    mockPick.mockResolvedValue(null);
    const { onCaptured, onDismiss } = renderModal();

    fireEvent.click(screen.getByText("Library"));

    await waitFor(() => expect(mockPick).toHaveBeenCalled());
    expect(onCaptured).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("clears a stale error when reopened, rather than greeting a fresh open with it", async () => {
    // The screen keeps this component mounted; only Paper's Modal internals
    // unmount on close, so error/busy state would otherwise outlive a reopen.
    takePictureAsync.mockResolvedValue({ uri: "file:///t.jpg" });
    const { setVisible } = renderModal();

    fireEvent.click(screen.getByText("Capture"));
    expect(await screen.findByText("No image captured")).toBeTruthy();

    setVisible(false);
    setVisible(true);

    await waitFor(() => expect(screen.queryByText("No image captured")).toBeNull());
    // And the shutter is usable again, not left disabled by a latched spinner.
    expect(screen.getByText("Capture")).toBeTruthy();
  });

  it("drops a shot that resolves after the modal was dismissed then reopened", async () => {
    let resolveShot!: (photo: { base64: string }) => void;
    takePictureAsync.mockReturnValue(
      new Promise<{ base64: string }>((r) => {
        resolveShot = r;
      }),
    );
    const { onCaptured, onDismiss, setVisible } = renderModal();

    fireEvent.click(screen.getByText("Capture"));
    setVisible(false);
    setVisible(true);
    resolveShot({ base64: "AAAA" });

    await waitFor(() => expect(takePictureAsync).toHaveBeenCalled());
    expect(onCaptured).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("drops a shot that resolves after the modal was dismissed and never reopened", async () => {
    // The commoner case: the user taps ✕ and walks away. Nothing reopens to
    // bump the session, so the invalidation has to happen on close itself.
    let resolveShot!: (photo: { base64: string }) => void;
    takePictureAsync.mockReturnValue(
      new Promise<{ base64: string }>((r) => {
        resolveShot = r;
      }),
    );
    const { onCaptured, onDismiss, setVisible } = renderModal();

    fireEvent.click(screen.getByText("Capture"));
    setVisible(false);
    resolveShot({ base64: "AAAA" });

    await waitFor(() => expect(takePictureAsync).toHaveBeenCalled());
    expect(onCaptured).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("rejects a capture whose bytes exceed the attach cap", async () => {
    takePictureAsync.mockResolvedValue({ base64: "A".repeat(30 * 1024 * 1024 + 1) });
    const { onCaptured, onDismiss } = renderModal();

    fireEvent.click(screen.getByText("Capture"));

    expect(
      await screen.findByText("Photo is too large to attach — try a lower resolution."),
    ).toBeTruthy();
    expect(onCaptured).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps the Library fallback usable when camera permission is denied", async () => {
    permission = { granted: false };
    mockPick.mockResolvedValue({
      base64: "BBBB",
      mime: "image/png",
      filename: "shot.png",
      kind: "image",
    });
    const { onCaptured } = renderModal();

    expect(screen.getByText("Camera permission required.")).toBeTruthy();
    fireEvent.click(screen.getByText("Library"));

    await waitFor(() =>
      expect(onCaptured).toHaveBeenCalledWith("BBBB", "image/png", "shot.png"),
    );
  });

  it("requests permission from the gate and reports a denial", async () => {
    permission = { granted: false };
    requestPermission.mockResolvedValue({ granted: false });
    renderModal();

    fireEvent.click(screen.getByText("Allow camera"));

    expect(await screen.findByText("Camera permission denied")).toBeTruthy();
  });
});
