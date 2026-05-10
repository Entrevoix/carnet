import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@carnet/shared";

import { getClient, getCurrentStatus, subscribeStatus } from "./client";

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(getCurrentStatus());

  useEffect(() => {
    // Surface keychain/network failures in devtools instead of letting the
    // promise float silently — otherwise the pill stays "disconnected" with
    // no diagnostic.
    getClient().catch((e: unknown) => {
      console.warn("[carnet] getClient failed:", e);
    });
    const unsubscribe = subscribeStatus(setStatus);
    return unsubscribe;
  }, []);

  return status;
}
