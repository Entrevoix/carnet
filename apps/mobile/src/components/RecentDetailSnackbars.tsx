import { Snackbar } from "react-native-paper";

import { karakeepSnackbarMessage } from "../lib/recentDetailView";

interface RecentDetailSnackbarsProps {
  karakeepDone: boolean;
  karakeepUpdated: boolean;
  karakeepSkipNote: string | null;
  onDismissKarakeepDone: () => void;
  karakeepQueued: boolean;
  onDismissKarakeepQueued: () => void;
  relatedLinked: string | null;
  onDismissRelatedLinked: () => void;
  photoAttached: boolean;
  onDismissPhotoAttached: () => void;
  enhancedWith: string | null;
  onDismissEnhancedWith: () => void;
}

/**
 * The note detail screen's transient success/notice snackbars, in one place so
 * the screen body stays about the note. Each is independently visible — Paper
 * queues them — and each owns only its own dismissal.
 */
export function RecentDetailSnackbars({
  karakeepDone,
  karakeepUpdated,
  karakeepSkipNote,
  onDismissKarakeepDone,
  karakeepQueued,
  onDismissKarakeepQueued,
  relatedLinked,
  onDismissRelatedLinked,
  photoAttached,
  onDismissPhotoAttached,
  enhancedWith,
  onDismissEnhancedWith,
}: RecentDetailSnackbarsProps) {
  return (
    <>
      <Snackbar
        visible={karakeepDone}
        onDismiss={onDismissKarakeepDone}
        // The skip notice names files — give it time to be read.
        duration={karakeepSkipNote ? 7000 : 2500}
      >
        {karakeepSnackbarMessage(karakeepUpdated, karakeepSkipNote)}
      </Snackbar>

      <Snackbar
        visible={relatedLinked !== null}
        onDismiss={onDismissRelatedLinked}
        duration={2500}
      >
        {relatedLinked ?? ""}
      </Snackbar>

      <Snackbar
        visible={photoAttached}
        onDismiss={onDismissPhotoAttached}
        duration={2500}
      >
        Photo attached.
      </Snackbar>

      <Snackbar
        visible={enhancedWith !== null}
        onDismiss={onDismissEnhancedWith}
        duration={2500}
      >
        {enhancedWith ? `Enhanced with ${enhancedWith}.` : ""}
      </Snackbar>

      <Snackbar
        visible={karakeepQueued}
        onDismiss={onDismissKarakeepQueued}
        // Informational, not an error — the export will send itself; give the
        // VPN hint time to be read.
        duration={6000}
      >
        Karakeep is unreachable — export queued, it will send when the server is
        reachable. Check VPN/Tailscale.
      </Snackbar>
    </>
  );
}
