import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@carnet/shared";

import { getClient, getCurrentStatus, subscribeStatus } from "./client";

/**
 * Live connection status from the singleton NavettedClient. Triggers a
 * `getClient()` call on first mount so the connection is established lazily
 * when any screen needing status is opened.
 */
export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(getCurrentStatus());

  useEffect(() => {
    void getClient();
    const unsubscribe = subscribeStatus(setStatus);
    return unsubscribe;
  }, []);

  return status;
}
