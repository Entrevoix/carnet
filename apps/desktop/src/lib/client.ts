import { NavettedClient, type ConnectionStatus } from "@carnet/shared";

import { getClientId, getSettings, type Settings } from "./storage";

type StatusListener = (status: ConnectionStatus, detail?: string) => void;

let cachedClient: NavettedClient | null = null;
let cachedKey: string | null = null;
let buildingClient: Promise<NavettedClient> | null = null;
const listeners = new Set<StatusListener>();
let lastStatus: ConnectionStatus = "disconnected";

function settingsKey(settings: Settings, clientId: string): string {
  return `${settings.navettedUrl}|${settings.navettedToken}|${clientId}`;
}

function broadcastStatus(status: ConnectionStatus, detail?: string): void {
  lastStatus = status;
  listeners.forEach((cb) => cb(status, detail));
}

async function buildClient(): Promise<NavettedClient> {
  const settings = await getSettings();
  const clientId = getClientId();
  const key = settingsKey(settings, clientId);

  if (cachedClient && cachedKey === key) {
    return cachedClient;
  }
  if (cachedClient) {
    cachedClient.disconnect();
  }

  const client = new NavettedClient({
    url: settings.navettedUrl,
    token: settings.navettedToken,
    clientId,
    onStatus: broadcastStatus,
  });
  client.connect();
  cachedClient = client;
  cachedKey = key;
  return client;
}

/**
 * Returns a singleton NavettedClient. Concurrent callers serialise behind a
 * single in-flight build promise so we never construct two NavettedClients
 * for the same key. Mirrors the mobile pattern.
 */
export function getClient(): Promise<NavettedClient> {
  if (buildingClient) return buildingClient;
  buildingClient = buildClient().finally(() => {
    buildingClient = null;
  });
  return buildingClient;
}

export function subscribeStatus(cb: StatusListener): () => void {
  listeners.add(cb);
  cb(lastStatus);
  return () => {
    listeners.delete(cb);
  };
}

export function getCurrentStatus(): ConnectionStatus {
  return lastStatus;
}

export function disconnectClient(): void {
  if (cachedClient) {
    cachedClient.disconnect();
    cachedClient = null;
    cachedKey = null;
  }
}
