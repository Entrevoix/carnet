/**
 * Shared plaintext-host allowlist for the credentialed backend clients
 * (OmniRoute + Karakeep). A Bearer API key must NEVER travel over cleartext
 * `http://` to an arbitrary host.
 *
 * HTTPS is always allowed. Plain `http://` is allowed ONLY for a fixed set of
 * local / LAN hosts where the dev + self-hosted loop legitimately runs:
 *   - `localhost` / `127.0.0.1` (loopback)
 *   - `10.0.0.0/8`   (RFC1918 — host-on-LAN dev loop)
 *   - `192.168.0.0/16` (RFC1918 — a user may run OmniRoute at 192.168.x)
 *
 * The previous implementation used a right-unanchored prefix regex
 * (`/^http:\/\/(localhost|127\.0\.0\.1|10\.)/`). That let `http://10.evil.com`,
 * `http://localhost.attacker.com`, and `http://127.0.0.1.attacker.com` through
 * — leaking the Bearer key to an attacker host. Exact hostname parsing via
 * `new URL()` closes that bypass.
 */

/** True when `url`'s host is one of the allowed cleartext local/LAN hosts.
 * Consulted only for `http://` URLs — see {@link isCredentialSafeUrl}. */
export function isAllowedPlaintextHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    const parts = hostname.split(".");
    const allNumeric =
      parts.length === 4 && parts.every((p) => /^\d+$/.test(p));
    if (!allNumeric) return false;
    // 10.0.0.0/8
    if (parts[0] === "10") return true;
    // 192.168.0.0/16
    if (parts[0] === "192" && parts[1] === "168") return true;
    return false;
  } catch {
    return false;
  }
}

/** True when `url` is safe to send a Bearer API key to: any `https://` URL, or
 * an `http://` URL whose host is in the local/LAN allowlist. Everything else
 * (other schemes, unparseable URLs, plain http to a public host) is false. */
export function isCredentialSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:") return true;
    if (protocol === "http:") return isAllowedPlaintextHost(url);
    return false;
  } catch {
    return false;
  }
}
