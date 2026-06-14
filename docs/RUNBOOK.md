# Runbook — Carnet

Carnet has **no server or hosted backend**. "Operations" means building and installing
the Android app and configuring each device; notes sync peer-to-peer via Syncthing.
For architecture see [CODEMAPS/architecture.md](CODEMAPS/architecture.md).

## Build & install the Android app
Release APK (the script auto-installs to the attached device):
```bash
cd apps/mobile && ANDROID_HOME="$HOME/Android/Sdk" npm run android:release
```
- Pin a device when several are attached: `ANDROID_SERIAL=<serial> npm run android:release`.
- Dev (Metro) run: `npm run mobile`, then `npm -w @carnet/mobile run android`.
- After adding a **new native module**, run `npx expo prebuild -p android --no-install` first to autolink.

## First-run device configuration
1. **OmniRoute / navetted (LLM gateway)** — enter base URL + credentials in **Settings**.
   No `.env`; creds live on the device. A blank URL surfaces a "not configured" error.
2. **Syncthing** — pair the device folder `/Documents/carnet/` with the workstation vault
   `~/Obsidian/Carnet/`. Full steps: [sync-setup.md](sync-setup.md).
3. **Karakeep** *(optional)* — to use per-note "Send to Karakeep" export, enter the instance URL
   + API key (Karakeep UI → User Settings → API Keys) in **Settings**. URL must be `https://`
   (loopback/`10.x` HTTP allowed for dev). Left blank, the export action surfaces "not configured".
4. **Smoke test** the capture modes once configured: [smoke-test.md](smoke-test.md).

## Health & monitoring
N/A — there is no service to monitor. "Healthy" = captures land in the vault and Syncthing
reports the folder in sync. Offline captures buffer in the on-device queue (AsyncStorage,
`lib/queue.ts`) and drain automatically on reconnect.

## Common issues
| Symptom | Cause / fix |
|---|---|
| Release build: `Cannot find module 'metro-runtime/package.json'` | npm pruned the hoisted copy. `metro-runtime` is pinned at the workspace root to keep it; re-pin to match `metro` after an Expo/metro bump. |
| Release build fails fetching gradle deps (`dl.google.com`) | This build env can't fetch **uncached** Google-Maven deps; a new native module needs its transitive deps pre-cached. |
| "No working speech service" (STT) | A non-Google RecognitionService was selected; `voice/recognizerSelect.ts` pins Google. The device also needs an on-device speech model — install it via the in-app prompt or **Settings → Voice input → Check voice setup** (`voice/sttReadiness.ts`). |
| "Not configured" on capture | OmniRoute base URL / creds are blank in Settings — re-enter on the device. |
| Karakeep export fails / "not configured" | Karakeep URL or key blank, or URL not `https://` (loopback/`10.x` HTTP excepted). Set both in Settings. Attachments sync incrementally per bookmark; a lost on-device record can re-upload a duplicate asset (harmless). |

## Rollback
- **App:** install the previous release APK.
- **Data:** the vault is plain Markdown under Syncthing — restore from any synced peer or
  from Obsidian's file history. No migrations to reverse.
