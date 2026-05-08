import { NavettedClient, type ConnectionStatus } from "@carnet/shared";

import { getClientId, getSettings, type Settings } from "./settings";

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
  const clientId = await getClientId();
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
 * Returns a singleton NavettedClient. If settings or client_id change between
 * calls (e.g. user updated the token in Settings), a new client is built and
 * the previous one is disconnected.
 *
 * Concurrency: parallel callers serialise behind a single in-flight build
 * promise so we never construct two NavettedClients for the same key.
 *
 * The optional `onStatus` callback is registered synchronously (before the
 * await fence) as a long-lived listener. For long-lived listeners (e.g.
 * status indicators on multiple screens), prefer `subscribeStatus(cb)` which
 * returns an unsubscribe fn.
 */
export function getClient(
  onStatus?: StatusListener,
): Promise<NavettedClient> {
  // Listener registration MUST be synchronous so two parallel callers don't
  // race the listener add against a buildingClient resolution.
  if (onStatus) {
    listeners.add(onStatus);
    onStatus(lastStatus);
  }

  if (buildingClient) {
    return buildingClient;
  }

  buildingClient = buildClient().finally(() => {
    buildingClient = null;
  });
  return buildingClient;
}

/**
 * Subscribe to connection-status changes. Returns an unsubscribe function.
 * Multiple subscribers are supported; each receives the latest status
 * immediately on subscribe.
 */
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
