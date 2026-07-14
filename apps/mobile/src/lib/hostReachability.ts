/**
 * VPN/Tailscale-aware host reachability probe.
 *
 * NetInfo can't answer "can I reach my Karakeep server" — wifi looks
 * "connected" while a tailnet host is unreachable because the VPN is down.
 * So instead of asking the OS about connectivity, we ask the host itself:
 * fire a short fetch at the base URL and treat ANY HTTP response (401/404/405
 * included) as "reachable" — an auth or routing error still proves the socket
 * path works. Only a network-level failure (DNS, refused connection, TLS,
 * timeout/abort) means "down".
 *
 * Used by the pending-sync drain (lib/pendingSyncRunner.ts) to decide whether
 * a queued export is worth attempting at all.
 */

/** Ceiling on the probe. Deliberately much shorter than the Karakeep client's
 * 20s request timeout — the probe's whole job is to fail fast so a drain pass
 * doesn't hang the foreground trigger behind an unreachable tailnet host. */
export const REACHABILITY_TIMEOUT_MS = 4_000;

/**
 * True when `baseUrl` answered with ANY http response within `timeoutMs`;
 * false on abort/network error or a blank URL. Never throws.
 */
export async function isHostReachable(
  baseUrl: string,
  timeoutMs: number = REACHABILITY_TIMEOUT_MS,
): Promise<boolean> {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // HEAD keeps the probe cheap; a server that rejects HEAD (405) still
    // responded, which is all we're measuring.
    await fetch(trimmed, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
