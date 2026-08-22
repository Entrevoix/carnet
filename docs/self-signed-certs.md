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
  **app-wide** in Carnet, not scoped to one provider's URL. A CA installed so
  Relais works is *equally* trusted for every other host Carnet talks to —
  api.openai.com, Anthropic's API, your Karakeep instance, anything. That CA
  could, in principle, intercept traffic to those too, not just Relais.
- Carnet opts into the browser's trust model (system CAs *and* user-installed
  CAs) here. That's **broader** than Android's own default for apps: since
  API 24, an app that doesn't ship a custom network security config trusts
  only the system CA store, and a user-installed CA is excluded unless the
  app opts in the way this one now does. This is a deliberate tradeoff for
  #176, not an oversight — a self-signed Relais is otherwise unusable over
  HTTPS, and Android's network-security-config can't scope trust per-domain
  here because the server's hostname is whatever the user configures.
- **Practical risk this creates**: if a CA gets installed into your device's
  user store through some other means — a corporate MDM profile, or a
  prompt you didn't fully read — that CA becomes trusted by Carnet for every
  provider, including your cloud LLM API keys. Before this feature, Carnet's
  cloud API traffic was protected by the system-CA-only default; now it
  isn't. Only install certificates you obtained yourself from a server you
  control, and be aware of what CAs are already in your device's user store
  (Settings → Security → Encryption & credentials → Trusted credentials →
  User tab).
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
