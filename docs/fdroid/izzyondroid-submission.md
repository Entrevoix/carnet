# IzzyOnDroid submission (Phase 1 of #182)

Submit as a new issue at <https://gitlab.com/IzzyOnDroid/applists/-/issues>
(requires a GitLab account; use their new-app issue template if one is offered)
titled **"Add: Carnet (com.ventouxlabs.carnet)"**. Ready-to-paste body:

---

**App name:** Carnet
**Application ID:** `com.ventouxlabs.carnet`
**Source / releases:** https://github.com/Entrevoix/carnet (APK attached to every
GitHub Release, tag pattern `v*.*.*`, asset name `carnet-vX.Y.Z.apk`)
**License:** AGPL-3.0-only
**Category suggestion:** Writing / Internet

**Description:** Mobile-first Markdown capture for an Obsidian vault. Notes are
plain `.md` files written into a folder the user syncs themselves (e.g. with
Syncthing) — no server, no database, no account. Optional LLM enrichment talks
only to endpoints the user configures (self-hosted or on-device); nothing is
preconfigured to a remote service. Fastlane metadata (descriptions + per-version
changelogs) is maintained in-repo under `fastlane/metadata/android/en-US/`.

**Signing:** Upstream self-signed. The release workflow independently verifies the
APK certificate against a pinned SHA-256 before publishing
(`.github/workflows/release.yml`); current fingerprint:
`e5f5ed37e098e0da7b09a59734845b21c986a18d1994bbdb670d01e3c7a3eaf7`.

**Size note:** current APK is ~117 MB (v0.7.0: 116,926,099 bytes). This is the
unstripped Expo SDK 54 / React Native 0.81 baseline (Hermes + per-ABI native
libs); no bundled ML models. Happy to discuss per-ABI splits if size is a
concern for the repo.

**Privacy:** no trackers, no analytics, no crash reporting that leaves the
device; API keys stored via Android Keystore (expo-secure-store). Network
access only to user-entered endpoints plus optional self-hosted Karakeep.

---

After acceptance, Izzy's updater pulls each new tagged GitHub Release
automatically — no changes needed to the release workflow.
