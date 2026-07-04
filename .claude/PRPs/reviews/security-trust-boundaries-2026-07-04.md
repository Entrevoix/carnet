# Security review — trust boundaries (2026-07-04)

**Scope:** read-only review of the seven trust boundaries surfaced by AUDIT.md. **Method:** targeted code review with file:line evidence; every "sound" item was verified, not assumed. **Threat model:** single-developer personal device today — but findings are graded for the moment carnet reaches *non-developer dogfooders*, since that's the point at which the vault-as-code-execution surface (H1) acquires real victims (dogfooders are the ones likely to run Obsidian Dataview).

**Bottom line:** the core hardening is genuinely solid (filename allowlists, size caps, secret storage, Bearer redaction, deep-link passivity — all verified). One HIGH should gate non-developer dogfooding; two MEDIUM are cheap fixes to controls that already exist but are bypassable; one MEDIUM is the known plaintext-queue TODO, now more sensitive because it carries GPS.

## Findings

### H1 (HIGH) — LLM/attacker-controlled markdown written to the synced vault with no sanitization; active content executes in Obsidian

- **Where:** `omniroute.ts:299-311` (only `stripCodeFences` + empty-check) → verbatim to disk via `writer.ts` `writeIdea`/`appendJournal`/`writePerson`. No content validator anywhere.
- **Chain:** hostile inputs cross into the model — web-page metadata (`urlpreview.ts` → `buildSharedLinkPrompt`), attacker-printed business-card OCR (`buildPersonPrompt`), shared text from any app. `INJECTION_GUARD` (`prompts.ts:29-31`) is a soft mitigation, not a control: a successful injection makes the model emit arbitrary markdown, written unchanged into a vault Syncthing replicates to a full Obsidian workstation. Obsidian + Dataview (near-ubiquitous) executes ` ```dataviewjs ` blocks; raw `<script>`/`<img onerror>` HTML and `[x](javascript:…)` links are also live there.
- **Impact:** stored-content → code execution on the workstation, or silent data-exfil links, planted by a page the user merely shared.
- **Fix direction:** sanitize the model's markdown before write — strip fenced `dataviewjs`/`js`/`html` blocks, neutralize raw HTML and `javascript:`/`data:` link targets, assert frontmatter parses to the expected key set. One denylist pass in `omniroute.ts` before returning `markdown` covers all capture modes. This is also the natural home for the frontmatter normalizer (AUDIT.md §1.5 / Stage 2 B3) — do them together.

### M2 (MEDIUM) — SSRF guard in URL preview is bypassable via redirect

- **Where:** `urlpreview.ts:225` (`isBlockedHost` runs only on the initial URL) + `:192` (`redirect: "follow"`). The block-list (loopback, `169.254.169.254`) is never re-checked after a 30x.
- **Impact:** a public page the user shares can redirect the preview fetch to cloud-metadata or a LAN host. Blind (non-HTML bodies rejected at `:238`) but the **GET still fires** — enough for LAN GET-CSRF and metadata probing. User-initiated (Save on ShareReceive), which bounds it.
- **Fix direction:** `redirect: "manual"`, re-run `isBlockedHost` on each hop's `Location`; or resolve+validate the final host before reading the body.

### M3 (MEDIUM) — HTTPS-enforcement regex prefix-matches, allowing cleartext API-key transmission

- **Where:** `omniroute.ts:181` and identical `karakeep.ts:105`: `/^http:\/\/(localhost|127\.0\.0\.1|10\.)/i` — unanchored on the right.
- **Impact:** `http://10.evil.com`, `http://localhost.attacker.com`, `http://127.0.0.1.attacker.com` all satisfy it; the Bearer key goes over plain HTTP to an attacker host. Requires the user to configure a crafted/typo'd/hijacked URL (hence Medium), but it defeats the exact control meant to protect the key. (Also relevant to AUDIT.md Open Question 1: the allowlist covers `localhost`/`127.*`/`10.*` but **not** `192.168.*`, so a plain-HTTP `192.168.x` OmniRoute URL is rejected outright — the real endpoint must be HTTPS.)
- **Fix direction:** parse with `new URL()` and match the exact hostname (`=== "localhost"`, `=== "127.0.0.1"`, or a numeric `10.0.0.0/8` check) instead of a prefix regex.

### M4 (MEDIUM) — Offline queue persists sensitive content + geolocation in plaintext

- **Where:** `queue.ts:196-208`, `:135-137`, `:70-73`. `payload_json` (AsyncStorage, unencrypted) holds raw idea/journal transcript/OCR/context text plus `location: lat,lon`. Permanently-failed rows (attempts ≥ 10) persist until manual `clearFailedRows` (`:316`).
- **Impact:** AsyncStorage is app-private but not encrypted — readable via `adb backup` or on a rooted device. This is the known `TODO.md:26` item, raised from "text PII" to include precise GPS. The API key is correctly **not** in the queue (read fresh from SecureStore) — that part is sound.
- **Fix direction:** move the queue to an encrypted store (AES-GCM via `expo-crypto` with a SecureStore key, per the TODO), or auto-purge drained/failed rows on a retention window. Note SQLCipher-via-expo-sqlite is currently blocked (`queue.ts:16` ABI error), so the encrypt-payload approach is the near-term path.

### L5 (LOW) — `*/*` share intent lets HTML/SVG land in the synced vault

- **Where:** `app.json:69` registers `"*/*"`; `ShareReceiveScreen.tsx:284-330` writes non-image/audio files verbatim to `Files/`. A shared `.html`/`.svg` syncs to the workstation and runs JS if later opened from the vault in a browser. User-initiated (share + open) → Low, but pairs with H1's threat model. On-disk filename is safely slugified (no path risk); the concern is the stored active-content file.
- **Fix direction:** consider an extension denylist or a "contains active content" warning on non-media shares; low priority.

### L6 (LOW) — External-image beaconing in the in-app renderer

- **Where:** `inlineImageSrc.ts:40` renders any `http(s):`/`data:` image `src` directly. An injected `![](http://attacker/x.png)` beacons the attacker (IP/timing) when the note is viewed in-app and again in Obsidian.
- **Fix direction:** closed automatically once H1's sanitization neutralizes remote embeds; no separate work if H1 lands.

## Verified sound (checked, not assumed)

- **Filename allowlist** — `personFilename` (`writer.ts:599-610`) asserts `^[A-Za-z0-9'\-]+$`; `slugify` (`:557-590`) reduces to `[a-z0-9-]` with edge-trim. `..`, `/`, unicode, empty all collapse to safe fallbacks. No traversal, no reserved-name/cross-subdir collision.
- **Paired-binary link traversal** — `PAIRED_BINARY_LINK` (`writer.ts:405`) uses `[^/\s)]+`, rejecting `/`; `../Photos/../../secret` can't escape. Consistent across archive + read paths.
- **Share-metadata interpolation** — `sanitizeShareString` strips CR/LF, `yamlQuote` escapes `\`/`"`/newlines (`shareHelpers.ts:36-53`); malicious mime/filename can't inject a frontmatter field.
- **Size/OOM caps** — image 8 MB (`omniroute.ts:136`, rechecked against actual decoded bytes via `assertBase64UnderLimit`), audio 25 MB, generic share 200 MB with post-read recheck (`ShareReceiveScreen.tsx:238-255,291-305`).
- **Bearer redaction** — `sanitizeErrorMessage` in both clients (`omniroute.ts:165-169`, `karakeep.ts:92-96`) + `queue.ts:55-59` strip `Bearer`/`Authorization:` before any error is stored/toasted/logged.
- **Secret storage** — OmniRoute + Karakeep keys only in SecureStore, never in the settings blob or queue (`settings.ts:186-231`); UI reads presence, never value. Legacy navetted token purged unconditionally (`:175-184`) and on banner dismiss (`:294-300`).
- **urlpreview hardening (aside from M2)** — protocol allowlist rejects `javascript:`/`file:`/`content:` (`:221`), code points clamped (`:70-79`), 256 KB body cap, 8 s timeout, non-HTML rejected, never throws.
- **Vision mime allowlist** — `enrichSharedImage` allowlists the data-URL mime, falls back to `image/jpeg` (`omniroute.ts:487-489`).
- **Frontmatter integrity** — newline guards in `rewriteFrontmatterField`/`upsertFrontmatterField` (`frontmatter.ts:158,242`) + `upsertSection` heading guard (`writer.ts:356`); byte-exact `splitFrontmatter`. A malicious LLM frontmatter corrupts only its own note.
- **Android surface** — deep links passive-navigate-only (`App.tsx:42-70` + explicit security comment; every target requires manual Save). `CaptureForegroundService` `exported=false`; `BootReceiver` (`exported=true`) acts only on protected `BOOT_COMPLETED`; widget receiver only on `APPWIDGET_UPDATE`. PendingIntents use `setPackage` + `FLAG_IMMUTABLE` (`withCaptureNotification.js:127-137`, `withCaptureWidget.js:79-90`). Shortcut XML uses `escapeXml` (`withAppShortcuts.js:56-66`).

## Recommended sequencing

1. **H1 before any non-developer dogfooding** — it converts the vault into a remote-code-execution surface. Land it with the AUDIT.md §1.5 frontmatter normalizer (same code path).
2. **M2 + M3 together** — both small, self-contained fixes to existing controls (redirect handling; `new URL()` host check).
3. **M4 before dogfooding** — now carries GPS; encrypt-payload path (SQLCipher is blocked).
4. **L5/L6** — L6 falls out of H1; L5 is optional polish.
