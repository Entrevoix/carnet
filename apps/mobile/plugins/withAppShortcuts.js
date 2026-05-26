// Adds 4 static Android app shortcuts (Idea / Journal / Photo / Contact)
// so a long-press on the carnet launcher icon jumps straight into the
// right capture screen via a carnet:// deep link, skipping Home.
//
// Two stages:
//   1. withAndroidManifest — inject a <meta-data> entry inside MainActivity
//      pointing at @xml/shortcuts (idempotent — won't double-add on re-prebuild).
//   2. withDangerousMod (Android) — write the actual resource files into
//      android/app/src/main/res/{xml, drawable}/ during prebuild. There's
//      no built-in helper for arbitrary resource files; this is the canonical
//      escape hatch. Files get regenerated on every `expo prebuild --clean`.
//
// Vector drawables use Material Icons path data filled with the Ink & Mist
// indigo (#5E63FF) so shortcuts feel branded, not stock-system-default.
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const SHORTCUTS_META_NAME = 'android.app.shortcuts';
const SHORTCUTS_RESOURCE = '@xml/shortcuts';
const PRIMARY_COLOR = '#5E63FF';

// Material Icons outlined variants, keyed by drawable filename. Kept as a
// flat lookup so the SHORTCUTS table stays scannable — opaque path data
// shouldn't crowd the per-shortcut metadata. If an icon ever renders
// blank on a real device, suspect a typo in the path data below before
// blaming the launcher.
const SHORTCUT_ICON_PATHS = {
  // ic_lightbulb_outline
  shortcut_idea:
    'M9,21c0,0.55 0.45,1 1,1h4c0.55,0 1,-0.45 1,-1v-1H9V21zM12,2C8.14,2 5,5.14 5,9c0,2.38 1.19,4.47 3,5.74V17c0,0.55 0.45,1 1,1h6c0.55,0 1,-0.45 1,-1v-2.26c1.81,-1.27 3,-3.36 3,-5.74C19,5.14 15.86,2 12,2zM14.85,13.1L14,13.7V16h-4v-2.3l-0.85,-0.6C7.8,12.16 7,10.63 7,9c0,-2.76 2.24,-5 5,-5s5,2.24 5,5C17,10.63 16.2,12.16 14.85,13.1z',
  // ic_mic_outline
  shortcut_journal:
    'M12,14c1.66,0 3,-1.34 3,-3V5c0,-1.66 -1.34,-3 -3,-3s-3,1.34 -3,3v6C9,12.66 10.34,14 12,14zM11,5c0,-0.55 0.45,-1 1,-1s1,0.45 1,1v6c0,0.55 -0.45,1 -1,1s-1,-0.45 -1,-1V5zM17,11c0,2.76 -2.24,5 -5,5s-5,-2.24 -5,-5H5c0,3.53 2.61,6.43 6,6.92V21h2v-3.08c3.39,-0.49 6,-3.39 6,-6.92H17z',
  // ic_photo_camera_outline
  shortcut_photo:
    'M12,12m-3.2,0a3.2,3.2 0,1 1,6.4 0a3.2,3.2 0,1 1,-6.4 0M9,2L7.17,4H4c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2h-3.17L15,2H9zM20,18H4V6h4.05l0.59,-0.65L9.88,4h4.24l1.24,1.35l0.59,0.65H20V18zM12,7c-2.76,0 -5,2.24 -5,5s2.24,5 5,5s5,-2.24 5,-5S14.76,7 12,7z',
  // ic_person_outline
  shortcut_person:
    'M12,5.9c1.16,0 2.1,0.94 2.1,2.1s-0.94,2.1 -2.1,2.1S9.9,9.16 9.9,8 10.84,5.9 12,5.9M12,14.9c2.97,0 6.1,1.46 6.1,2.1v1.1H5.9V17c0,-0.64 3.13,-2.1 6.1,-2.1M12,4C9.79,4 8,5.79 8,8s1.79,4 4,4 4,-1.79 4,-4 -1.79,-4 -4,-4zM12,13c-2.67,0 -8,1.34 -8,4v3h16v-3c0,-2.66 -5.33,-4 -8,-4z',
};

const SHORTCUTS = [
  { id: 'idea',    rank: 0, shortLabel: 'Idea',    longLabel: 'Capture an idea',       uri: 'carnet://capture/idea',    drawableName: 'shortcut_idea' },
  { id: 'journal', rank: 1, shortLabel: 'Journal', longLabel: 'Voice journal entry',   uri: 'carnet://capture/journal', drawableName: 'shortcut_journal' },
  { id: 'photo',   rank: 2, shortLabel: 'Photo',   longLabel: 'Capture a photo',       uri: 'carnet://photo',           drawableName: 'shortcut_photo' },
  { id: 'person',  rank: 3, shortLabel: 'Contact', longLabel: 'Scan a business card',  uri: 'carnet://capture/person',  drawableName: 'shortcut_person' },
];

// AAPT validates that android:shortcutShortLabel / shortcutLongLabel are
// string resource references (@string/...), not inline literals. Inline
// labels build under some debug paths but break assembleRelease with
// "is incompatible with attribute (attr) reference". Emit a dedicated
// strings.xml and reference its keys from shortcuts.xml so release builds
// link cleanly.
function buildShortcutStringsXml() {
  const entries = SHORTCUTS.flatMap((s) => [
    `  <string name="shortcut_${s.id}_short">${escapeXml(s.shortLabel)}</string>`,
    `  <string name="shortcut_${s.id}_long">${escapeXml(s.longLabel)}</string>`,
  ]).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
${entries}
</resources>
`;
}

function buildShortcutsXml(packageName) {
  const mainActivityFqn = `${packageName}.MainActivity`;
  // Static shortcuts display in the order they appear in shortcuts.xml,
  // so android:shortcutRank is redundant — AAPT also rejects it on some
  // build-tools versions even though Android docs list it as valid.
  // Order the SHORTCUTS array if you want a different launcher order.
  const entries = SHORTCUTS.map(
    (s) => `  <shortcut
    android:shortcutId="${s.id}"
    android:enabled="true"
    android:icon="@drawable/${s.drawableName}"
    android:shortcutShortLabel="@string/shortcut_${s.id}_short"
    android:shortcutLongLabel="@string/shortcut_${s.id}_long">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${packageName}"
      android:targetClass="${mainActivityFqn}"
      android:data="${s.uri}" />
  </shortcut>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${entries}
</shortcuts>
`;
}

function buildVectorDrawable(pathData) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="${PRIMARY_COLOR}"
      android:pathData="${pathData}" />
</vector>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = function withAppShortcuts(config) {
  // Read the package name from Expo config so a rebrand / fork / white-label
  // doesn't silently break the shortcut intents. expo prebuild requires
  // android.package to build anything; if it's absent here, the whole
  // prebuild fails for unrelated reasons.
  const packageName = config.android?.package;

  // Stage 1 — inject the meta-data inside MainActivity.
  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest?.application?.[0];
    if (!application) return cfg;
    const mainActivity = (application.activity ?? []).find(
      (a) => a?.$?.['android:name'] === '.MainActivity',
    );
    if (!mainActivity) {
      // Future Expo SDKs might rename MainActivity or change how it's
      // declared. Warn loudly so a silent regression here doesn't become
      // a 5-hour "why don't my shortcuts show up" investigation.
      console.warn(
        '[withAppShortcuts] MainActivity not found by selector ".MainActivity" — shortcuts meta-data not injected. Inspect the prebuilt AndroidManifest.xml.',
      );
      return cfg;
    }
    if (!Array.isArray(mainActivity['meta-data'])) {
      mainActivity['meta-data'] = [];
    }
    const already = mainActivity['meta-data'].some(
      (m) => m?.$?.['android:name'] === SHORTCUTS_META_NAME,
    );
    if (!already) {
      mainActivity['meta-data'].push({
        $: {
          'android:name': SHORTCUTS_META_NAME,
          'android:resource': SHORTCUTS_RESOURCE,
        },
      });
    }
    return cfg;
  });

  // Stage 2 — write the resource files at prebuild time.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const resDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
      );
      const xmlDir = path.join(resDir, 'xml');
      const drawableDir = path.join(resDir, 'drawable');
      const valuesDir = path.join(resDir, 'values');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.mkdirSync(valuesDir, { recursive: true });

      // strings.xml MUST land before shortcuts.xml references it; emit
      // strings first so AAPT sees the keys when linking shortcuts.xml.
      fs.writeFileSync(
        path.join(valuesDir, 'shortcut_strings.xml'),
        buildShortcutStringsXml(),
        'utf8',
      );

      fs.writeFileSync(
        path.join(xmlDir, 'shortcuts.xml'),
        buildShortcutsXml(packageName),
        'utf8',
      );
      for (const s of SHORTCUTS) {
        const pathData = SHORTCUT_ICON_PATHS[s.drawableName];
        fs.writeFileSync(
          path.join(drawableDir, `${s.drawableName}.xml`),
          buildVectorDrawable(pathData),
          'utf8',
        );
      }
      return cfg;
    },
  ]);

  return config;
};
