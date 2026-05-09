import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@carnet/shared";

import { getClient, getCurrentStatus, subscribeStatus } from "./client";

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(getCurrentStatus());

  useEffect(() => {
    getClient();
    const unsubscribe = subscribeStatus(setStatus);
    return unsubscribe;
  }, []);

  return status;
}
