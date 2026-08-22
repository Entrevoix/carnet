# Using a self-signed certificate with Carnet (issue #176)

Carnet's cleartext-consent toggle (#176 phase 1) lets you point a provider at
plain `http://` on a non-local host. If you'd rather keep TLS but your server
(a self-hosted Relais, OmniRoute, or similar) uses a self-signed certificate,
Carnet can trust it instead — the same way a desktop browser does — once you
install that certificate into Android's **user** CA store.

## 1. Get the server's certificate

If your server's admin UI offers a "download certificate" or "export CA"
option, use that. Otherwise, pull it directly with `openssl` from any machine
that can reach the server:

```bash
openssl s_client -connect your-server-host:8443 -showcerts </dev/null \
  | openssl x509 -outform PEM > server-cert.pem
```

Replace `your-server-host:8443` with the host and port Carnet is configured
to use. Transfer `server-cert.pem` to the Android device (e.g. via Syncthing,
email to yourself, or `adb push`).

## 2. Install it as a CA certificate on Android

Exact wording varies by Android version and OEM skin, but the path is
generally:

**Settings → Security (or "Security & privacy") → More security (& privacy)
→ Encryption & credentials → Install a certificate → CA certificate**

Android will show a warning before installing — this is expected: a CA
certificate is powerful (it can be used to intercept any TLS connection
identified against it), which is exactly why Android gates the install
behind your device PIN/biometric and this explicit prompt. Only install a
certificate you generated or downloaded yourself from a server you control.

## 3. What Carnet trusts, and what it doesn't

Carnet's network security config trusts both the standard system CA store
*and* the user CA store (`<certificates src="user" />`). This means:

- Any certificate you deliberately install via the steps above is trusted
  **app-wide** in Carnet, not scoped to one provider's URL.
- This is the same trust model a desktop browser uses for a manually
  imported CA — Carnet isn't doing anything more permissive than what
  Android itself already permits into every unpinned app.
- Uninstalling the certificate from Android Settings revokes Carnet's trust
  in it too — there's no separate Carnet-side list to manage.

## 4. After installing

Re-run "Test connection" for the provider in Carnet's Settings screen. A
certificate-trust failure surfaces as "Server uses a certificate this device
doesn't trust"; once the cert is installed and trusted, that should switch
to "Reachable" (or a normal auth/network-level result if something else is
still off).

## Troubleshooting

- **Still untrusted after installing**: double check you installed the
  server's actual leaf/CA certificate (not a client certificate, and not a
  certificate for the wrong host). Some servers auto-generate a fresh
  self-signed cert on every restart — if the server restarted since you
  exported it, re-export and reinstall.
- **"Install a certificate" isn't in the path above on my device**: search
  Settings for "certificate" — the exact menu depth is the part most likely
  to have moved between Android releases and OEM skins.
