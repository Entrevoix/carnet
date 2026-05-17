// Adds a <queries><intent> entry for android.speech.RecognitionService so
// PackageManager.queryIntentServices() returns every installed STT provider,
// not just the packages listed in androidSpeechServicePackages. Needed
// whenever a user's STT provider (e.g. a Samsung/OEM build, or an unexpected
// variant of Google TTS) isn't in our explicit whitelist.
const { withAndroidManifest } = require('@expo/config-plugins');

const RECOGNITION_ACTION = 'android.speech.RecognitionService';

module.exports = function withSpeechRecognitionQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!Array.isArray(manifest.queries)) manifest.queries = [{}];
    if (manifest.queries.length === 0) manifest.queries.push({});
    const q = manifest.queries[0];
    if (!Array.isArray(q.intent)) q.intent = [];
    const already = q.intent.some((i) =>
      Array.isArray(i.action) &&
      i.action.some((a) => a?.$?.['android:name'] === RECOGNITION_ACTION),
    );
    if (!already) {
      q.intent.push({
        action: [{ $: { 'android:name': RECOGNITION_ACTION } }],
      });
    }
    return cfg;
  });
};
