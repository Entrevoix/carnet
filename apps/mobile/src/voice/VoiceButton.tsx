// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { MIN_TAP_TARGET, useCarnetTheme } from '../lib/theme';
import {
  type RecognizerOption,
  SYSTEM_DEFAULT_RECOGNIZER,
  DEFAULT_RECOGNIZER_PKGS,
  orderRecognizerCandidates,
  isPinnedRecognizer,
  resolveEffectivePkg,
  pinnedFailoverChain,
  composeFlush,
} from './recognizerSelect';
import { triggerVoiceModelDownload } from './sttReadiness';
import { describeSttError, isFailoverEligibleCode } from './sttErrorMessage';

// Tap-to-toggle max recording — Soda starts to misbehave past a few minutes; cap to 3.
const MAX_RECORDING_MS = 3 * 60 * 1000;

// Recognizer packages to actively reject if seen in storage. Module-level so
// it doesn't re-allocate on every render. Empty by default — com.google.android.tts
// is intentionally NOT here (see notes below).
const KNOWN_BAD_PKGS: readonly string[] = [];
// Android 16 fix: Soda's default LANGUAGE_MODEL flipped to AMBIENT_ONESHOT
// after the Sept 2025 security patch. Without web_search, dictation returns
// empty transcripts. (No standalone writeup exists for this — the full
// rationale lives in the startRecognizerRef comment below and this one.)
const SODA_DICTATION_MODEL = 'web_search';
export const STT_ENGINE_KEY = 'stt_engine';
export const STT_RECOGNIZER_PKG_KEY = 'stt_recognizer_pkg';
export const STT_RECOGNIZER_LABEL_KEY = 'stt_recognizer_label';

const KNOWN_RECOGNIZERS: RecognizerOption[] = [
  // Android System Intelligence — the actual on-device Google STT service. Prefer first.
  { pkg: 'com.google.android.as', label: 'Google (On-Device)' },
  // "Speech Services by Google" — the Play Store package that exposes Google STT
  // on most non-Pixel Androids (installed by anyone using Google TTS).
  { pkg: 'com.google.android.tts', label: 'Speech Services by Google' },
  { pkg: 'com.google.android.googlequicksearchbox', label: 'Google' },
  { pkg: 'com.google.android.voicesearch', label: 'Google Voice Search' },
  { pkg: 'com.google.android.apps.googleassistant', label: 'Google Assistant' },
  { pkg: 'com.samsung.android.bixby.agent', label: 'Samsung Bixby' },
  { pkg: 'com.samsung.android.speech', label: 'Samsung Voice' },
  { pkg: 'com.htc.sense.hsp', label: 'HTC Voice' },
  { pkg: 'com.nuance.android.vsuite.vsuiteapp', label: 'Nuance' },
  { pkg: 'com.iflytek.speechsuite', label: 'iFlytek' },
];

// FAILOVER_CODES moved to ./sttErrorMessage.ts (isFailoverEligibleCode) so
// it's unit-testable without pulling in this file's RN/expo native imports.
// 7 (ERROR_NO_MATCH_OR_UNAVAILABLE) is deliberately NOT in that set — it's
// handled as a silent same-recognizer restart below, not a failover trigger.

const PREFERRED_LANG = 'en-US';

// Single canonical copy for every "no working speech service" terminal
// state (detection found nothing, failover chain exhausted post-detection,
// or a null effectivePkg with detection already run). Previously three
// near-duplicate strings existed and drifted from each other during QA
// (2026-07-11) — unify so future edits can't reintroduce the split. All
// three sites present the same 'no-service' action buttons regardless of
// wording, so one message covers every trigger path.
const NO_SERVICE_MESSAGE =
  'No working speech service found on this device.\nInstall a speech service below, or copy diagnostics for details.';

// Returns the best locale the given recognizer can serve, preferring an
// already-installed match over a claimed-but-not-downloaded one. Falls back
// to the preferred tag when the probe throws (old Android or missing perm).
async function pickBestLocale(pkg: string | null, preferred = PREFERRED_LANG): Promise<string> {
  try {
    const opts = pkg ? { androidRecognitionServicePackage: pkg } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await ExpoSpeechRecognitionModule.getSupportedLocales(opts)) as any;
    const locales: string[] = Array.isArray(res?.locales) ? res.locales : [];
    const installed: string[] = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
    const lower = preferred.toLowerCase();
    const exact = (list: string[]) => list.find((l) => l.toLowerCase() === lower);
    const anyEn = (list: string[]) => list.find((l) => l.toLowerCase().startsWith('en-'));
    return exact(installed) ?? exact(locales) ?? anyEn(installed) ?? anyEn(locales) ?? preferred;
  } catch {
    return preferred;
  }
}

// sttErrorMessage moved to ./sttErrorMessage.ts (describeSttError) so the
// numeric-code / string-enum fallback logic is unit-testable without
// pulling in this file's RN/expo native imports. Kept as a thin local alias
// so the two call sites below don't need renaming.
const sttErrorMessage = describeSttError;

function labelForPackage(pkg: string): string {
  const known = KNOWN_RECOGNIZERS.find((r) => r.pkg === pkg);
  if (known) return known.label;
  // Fallback label: derive from last path segment, title-cased
  const seg = pkg.split('.').pop() ?? pkg;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

// Gather everything we know about the device's STT state. Returned as plain
// text so the user can paste it into a bug report.
async function collectDiagnostics(
  lastError: string | null,
  eventBuffer: string[] = [],
): Promise<string> {
  const lines: string[] = [];
  const ts = new Date().toISOString();
  lines.push(`carnet voice diagnostics @ ${ts}`);
  lines.push('');
  // getSpeechRecognitionServices
  try {
    const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
    lines.push(`getSpeechRecognitionServices() → [${(services ?? []).join(', ') || '(empty)'}]`);
  } catch (e: unknown) {
    lines.push(`getSpeechRecognitionServices() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  // getDefaultRecognitionService
  try {
    const def = ExpoSpeechRecognitionModule.getDefaultRecognitionService();
    lines.push(`getDefaultRecognitionService() → ${def?.packageName || '(empty)'}`);
  } catch (e: unknown) {
    lines.push(`getDefaultRecognitionService() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Per-package probes
  lines.push('');
  lines.push('Per-package getSupportedLocales probe:');
  for (const r of KNOWN_RECOGNIZERS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await ExpoSpeechRecognitionModule.getSupportedLocales({
        androidRecognitionServicePackage: r.pkg,
      })) as any;
      const locales: string[] = Array.isArray(res?.locales) ? res.locales : [];
      const installed: string[] = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
      lines.push(`  ${r.pkg}: ${locales.length} locales, ${installed.length} installed`);
    } catch (e: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (e as any)?.code ?? (e as any)?.nativeErrorCode;
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`  ${r.pkg}: ERROR code=${code ?? '?'} msg=${msg.slice(0, 80)}`);
    }
  }
  // Saved state
  lines.push('');
  const [savedPkg, savedLabel, savedEngine] = await Promise.all([
    AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY),
    AsyncStorage.getItem(STT_RECOGNIZER_LABEL_KEY),
    AsyncStorage.getItem(STT_ENGINE_KEY),
  ]);
  lines.push(`Saved engine: ${savedEngine ?? '(unset, defaults to on-device)'}`);
  lines.push(`Saved pkg: ${savedPkg ?? '(null)'}`);
  lines.push(`Saved label: ${savedLabel ?? '(null)'}`);
  lines.push(`Last error: ${lastError ?? '(none)'}`);
  lines.push('');
  lines.push(`Recent events (${eventBuffer.length}):`);
  if (eventBuffer.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const line of eventBuffer) lines.push('  ' + line);
  }
  return lines.join('\n');
}

async function detectAvailableRecognizers(): Promise<RecognizerOption[]> {
  // Primary: ask Android directly which recognizer services are installed.
  // This bypasses Android 11+ <queries> visibility issues and Android 13+
  // ERROR_LANGUAGE_UNAVAILABLE false negatives that the per-package probe hits.
  try {
    const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
    if (services && services.length > 0) {
      let defaultPkg = '';
      try {
        defaultPkg = ExpoSpeechRecognitionModule.getDefaultRecognitionService()?.packageName ?? '';
      } catch {
        // non-fatal
      }
      // Probe installed language models so a pinned engine with no on-device
      // speech pack (e.g. a com.google.android.as that only returns code 12)
      // ranks below a model-having one. Unknown/timeout → treat as has-model so
      // a slow probe never wrongly demotes a working recognizer.
      const candidates = Array.from(new Set([...DEFAULT_RECOGNIZER_PKGS, ...services]));
      const modelByPkg = new Map<string, boolean>();
      await Promise.all(
        candidates.map(async (pkg) => {
          try {
            const res = (await Promise.race([
              ExpoSpeechRecognitionModule.getSupportedLocales({ androidRecognitionServicePackage: pkg }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
            ])) as { installedLocales?: string[] } | undefined;
            const installed = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
            modelByPkg.set(pkg, installed.length > 0);
          } catch {
            modelByPkg.set(pkg, true); // unknown → don't demote
          }
        }),
      );
      // Always include our pinned Google recognizers (ranked first), even when
      // Android doesn't enumerate them — otherwise a device whose only
      // *enumerated* RecognitionService is a third-party app (e.g. an installed
      // assistant that can't actually serve STT) has no Google fallback, so that
      // app's recognizer gets picked and STT dies with code 5/9.
      return orderRecognizerCandidates(
        services,
        defaultPkg,
        labelForPackage,
        (pkg) => modelByPkg.get(pkg) ?? true,
      );
    }
  } catch {
    // fall through to legacy probe
  }

  // Fallback: legacy per-package probe for when getSpeechRecognitionServices
  // is unavailable or returns empty.
  const confirmed: RecognizerOption[] = [];
  const tentative: RecognizerOption[] = [];
  for (const r of KNOWN_RECOGNIZERS) {
    try {
      const result = await ExpoSpeechRecognitionModule.getSupportedLocales({
        androidRecognitionServicePackage: r.pkg,
      });
      if (result?.locales && result.locales.length > 0) {
        confirmed.push(r);
      }
    } catch (e: unknown) {
      const code = (e as { code?: number; nativeErrorCode?: number })?.code
        ?? (e as { code?: number; nativeErrorCode?: number })?.nativeErrorCode;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === 14 || msg.includes('14')) {
        tentative.push(r);
      }
    }
  }
  const found = confirmed.length > 0 ? confirmed : tentative;
  return [...found, SYSTEM_DEFAULT_RECOGNIZER];
}

interface VoiceButtonProps {
  onTranscript: (text: string, isFinal: boolean) => void;
  disabled?: boolean;
}

export interface VoiceButtonHandle {
  /** Stop recording and commit the in-progress transcript as final, instead of
   * losing it. No-op when not recording. The parent calls this before it opens
   * a picker / mutates state mid-dictation so the spoken words are saved. */
  stopAndFlush: () => void;
}

type ErrAction = 'none' | 'no-service' | 'permission' | 'lang-unavailable' | 'diag';

export const VoiceButton = forwardRef<VoiceButtonHandle, VoiceButtonProps>(
  function VoiceButton({ onTranscript, disabled }, ref) {
  const theme = useCarnetTheme();
  const [isListening, setIsListening] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [errPersist, setErrPersist] = useState(false);
  const [errAction, setErrAction] = useState<ErrAction>('none');
  const errPersistRef = useRef(false);
  const [detecting, setDetecting] = useState(false);
  // True while an in-app on-device voice-model download is in flight, so the
  // "Download voice model" button can disable + show progress.
  const [downloadingModel, setDownloadingModel] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerOptions, setPickerOptions] = useState<RecognizerOption[]>([]);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const errTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);
  const onTranscriptRef = useRef(onTranscript);

  // Ordered list of pkg candidates to try if the current recognizer fails
  // with a failover-eligible code. Shift-from-front; empty means no more
  // fallbacks and the error is final.
  const failoverChainRef = useRef<string[]>([]);
  // True once detection has seeded the chain this session, so a later failure
  // doesn't loop back into detection indefinitely.
  const detectionRanRef = useRef(false);
  // Retry counter for code-5/7 errors: Android 16 Soda may return ERROR_CLIENT
  // immediately after a continuous session ends (mid-teardown). Retry once with
  // a short delay before concluding the service is gone. Resets on successful start.
  const noServiceRetryRef = useRef(0);
  // Last raw STT error — surfaced in the diagnostics dump so the user can
  // share it in a bug report instead of just the friendly message.
  const lastErrorRef = useRef<string | null>(null);
  // Ring buffer of recent recognizer lifecycle events. Populated by every
  // listener so diagnostics can show whether the mic ever opened, whether
  // speech was detected, how long between events, etc.
  const eventBufferRef = useRef<string[]>([]);
  // Watchdog for "recognizer started but audio never flowed" — the silent
  // hang mode where nothing errors and nothing transcribes.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when an audio/speech event is observed so the watchdog knows audio
  // flowed and skips the hang handler.
  const audioSeenRef = useRef(false);
  const errorHandlingRef = useRef(false);
  const sessionFailedPkgsRef = useRef<Set<string>>(new Set());
  const lastAttemptedPkgRef = useRef<string | null>(null);

  // ── Tap-to-toggle recording state ───────────────────────────────────────
  // True while a recording session is active (between the start tap and the
  // end tap). Async paths must check this between awaits so a stop in flight
  // aborts the start.
  const pressActiveRef = useRef(false);
  // Per-utterance final segments, joined into the composed transcript.
  // continuous: true emits multiple isFinal results during a session (Soda
  // re-arms after each utterance boundary); we accumulate, then flush on
  // stop as a single isFinal=true callback.
  const finalSegmentsRef = useRef<string[]>([]);
  const sessionTextRef = useRef('');
  // Latest in-progress (isFinal=false) transcript for the current utterance.
  const interimRef = useRef('');
  // Set by stopAndFlush() so the `end` listener's user-stop branch doesn't
  // commit the transcript a second time after we've already flushed it.
  const flushedExternallyRef = useRef(false);
  // Recognizer auto-selected by detection but NOT yet persisted — we only write
  // it to AsyncStorage once it yields a real result (see the result listener),
  // so an enumerated-but-broken engine can't get remembered and re-fail every
  // launch. Cleared at detection-start and session-start so it can't leak.
  const pendingPersistRef = useRef<{ pkg: string; label: string } | null>(null);
  // Retry-once guard for code 11 (SERVER_DISCONNECTED), a transient Soda drop —
  // retry the same engine before failing over to a possibly model-less fallback.
  const serverDisconnectRetryRef = useRef(0);
  // Which engine the active session is using — used by handlePressOut to
  // route to stopOnDevice without re-reading AsyncStorage.
  const activeEngineRef = useRef<'ondevice' | null>(null);
  // Safety cap timer — auto-stops at MAX_RECORDING_MS so a forgotten
  // session can't pin the mic open forever.
  const maxDurationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Note: com.google.android.tts is intentionally NOT in KNOWN_BAD_PKGS (defined at module scope).
  // expo-speech-recognition docs explicitly list it as a valid getDefaultRecognitionService() return on some devices.

  // Self-heal: clear known-bad recognizer packages
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY).then((pkg) => {
      if (!mounted) return;
      if (pkg && KNOWN_BAD_PKGS.includes(pkg)) {
        AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
        AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
      }
    }).catch(() => { /* ignore teardown rejections */ });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Master unmount cleanup: stop all timers and animation loops so they
  // can't fire setState after the component (and Jest env) have torn down.
  useEffect(() => {
    return () => {
      if (errTimeout.current) { clearTimeout(errTimeout.current); errTimeout.current = null; }
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      if (maxDurationTimer.current) { clearTimeout(maxDurationTimer.current); maxDurationTimer.current = null; }
      pulseLoop.current?.stop(); pulseLoop.current = null;
      if (started.current) {
        try { ExpoSpeechRecognitionModule.stop(); } catch { /* ignore */ }
        started.current = false;
      }
    };
  }, []);

  useEffect(() => { onTranscriptRef.current = onTranscript; });

  const showErrRef = useRef((msg: string, ms = 8000, persist = false, action: ErrAction = 'none') => {
    // Guard: a persistent error must not be clobbered by a transient one.
    if (errPersistRef.current && !persist) return;
    errPersistRef.current = persist;
    setErrMsg(msg);
    setErrPersist(persist);
    setErrAction(action);
    if (errTimeout.current) clearTimeout(errTimeout.current);
    if (!persist) {
      errTimeout.current = setTimeout(() => {
        errTimeout.current = null;
        setErrMsg('');
      }, ms);
    }
  });

  const dismissErr = useCallback(() => {
    errPersistRef.current = false;
    setErrMsg('');
    setErrPersist(false);
    setErrAction('none');
  }, []);

  const openPlayStore = useCallback((pkg: string) => {
    const market = `market://details?id=${pkg}`;
    const web = `https://play.google.com/store/apps/details?id=${pkg}`;
    Linking.openURL(market).catch(() => Linking.openURL(web));
  }, []);

  const openAppSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);

  const retryDetection = useCallback(async () => {
    await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
    await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
    sessionFailedPkgsRef.current.clear();
    errorHandlingRef.current = false;
    detectionRanRef.current = false;
    dismissErr();
    await triggerDetectionRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissErr]);

  // Pull the on-device English voice model from inside the app (Android 13+),
  // the in-app fix for the code-12 / "no service found" dead-end. On success
  // we dismiss the sheet and retry dictation with the saved recognizer; for a
  // queued/dialog download we leave a hint; on failure we point at Speech Services.
  const handleDownloadModel = useCallback(async () => {
    setDownloadingModel(true);
    try {
      const result = await triggerVoiceModelDownload('en-US');
      if (result === 'installed') {
        dismissErr();
        await startRecognizerRef.current(await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY));
      } else if (result === 'dialog' || result === 'scheduled') {
        showErrRef.current('Downloading the English voice model… try dictation again in a moment.', 6000);
      } else {
        showErrRef.current('Could not start the model download. Open Speech Services to install it.', 5000);
      }
    } finally {
      setDownloadingModel(false);
    }
  }, [dismissErr]);

  const copyDiagnostics = useCallback(async () => {
    const text = await collectDiagnostics(lastErrorRef.current, [...eventBufferRef.current]);
    try { await Clipboard.setStringAsync(text); } catch { /* ignore */ }
    // Replace the current sheet with the diag view, force persistent.
    errPersistRef.current = true;
    if (errTimeout.current) { clearTimeout(errTimeout.current); errTimeout.current = null; }
    setErrMsg(text);
    setErrPersist(true);
    setErrAction('diag');
  }, []);

  const logEventRef = useRef((type: string, info?: unknown) => {
    const ts = new Date().toISOString().slice(11, 23);
    const suffix = info ? ' ' + JSON.stringify(info).slice(0, 120) : '';
    eventBufferRef.current.push(`${ts} ${type}${suffix}`);
    if (eventBufferRef.current.length > 40) eventBufferRef.current.shift();
  });

  const clearWatchdogRef = useRef(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  });

  const startWatchdogRef = useRef(() => {
    clearWatchdogRef.current();
    audioSeenRef.current = false;
    // 6s is enough that a cold recognizer has time to open the mic but short
    // enough that a genuinely-stuck one doesn't leave the user waiting.
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      if (!started.current) return;
      if (audioSeenRef.current) return;
      logEventRef.current('watchdog', { fired: true, reason: 'no-audio-6s' });
      stopListeningRef.current();
      lastErrorRef.current = 'watchdog: recognizer started but no audio captured within 6s';
      showErrRef.current(
        'Recognizer started but no audio was captured.\nThe English voice model may not be downloaded on this service, or another app is holding the mic. Tap "Copy diagnostics" to share the event log.',
        0, true, 'lang-unavailable',
      );
    }, 6000);
  });

  const startPulse = () => {
    pulseAnim.setValue(1);
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    pulseLoop.current.start();
  };

  const stopPulse = () => {
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
  };

  const stopListening = useCallback(() => {
    if (!started.current) return;
    started.current = false;
    clearWatchdogRef.current();
    try { ExpoSpeechRecognitionModule.stop(); } catch {}
    setIsListening(false);
    stopPulse();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopListeningRef = useRef(stopListening);
  useEffect(() => { stopListeningRef.current = stopListening; });

  // Recording helpers ─────────────────────────────────────────────────────
  const composeText = useCallback(() => {
    const finals = finalSegmentsRef.current.join(' ').trim();
    const interim = interimRef.current.trim();
    if (finals && interim) return `${finals} ${interim}`;
    return finals || interim;
  }, []);

  const resetAccumulator = useCallback(() => {
    finalSegmentsRef.current = [];
    interimRef.current = '';
  }, []);

  const clearMaxTimer = useCallback(() => {
    if (maxDurationTimer.current) {
      clearTimeout(maxDurationTimer.current);
      maxDurationTimer.current = null;
    }
  }, []);

  // Fires the native recognizer. Shared by the start-tap path, post-detection
  // auto-start, and picker auto-start — all share the same start options.
  //
  // Android 16 (Sept 2025 security patch) flipped Soda's default LANGUAGE_MODEL
  // to AMBIENT_ONESHOT, which returns empty transcripts for dictation audio.
  // The fix is to ALWAYS pin com.google.android.tts as the recognizer (Pixel's
  // settings:secure:voice_recognition_service is null by default, so unpinned
  // createSpeechRecognizer() throws code 5) AND to pass EXTRA_LANGUAGE_MODEL=
  // 'web_search' so Soda routes through the dictation pipeline.
  //
  // Do NOT reintroduce requiresOnDeviceRecognition or EXTRA_PREFER_OFFLINE here:
  // both fail or are silently ignored on Android 16.
  const startRecognizerRef = useRef(async (pkg: string | null) => {
    // pkg meanings: non-empty string = explicit package; '' ("system default")
    // and null ("try defaults") both resolve to a pinned Google recognizer. We
    // deliberately never do a bare start (which would hand STT to Android's
    // registered default recognizer — on some devices a third-party app that
    // can't serve STT). See resolveEffectivePkg for the full rationale.
    const effectivePkg = resolveEffectivePkg(pkg, (p) =>
      sessionFailedPkgsRef.current.has(p),
    );
    if (pkg && pkg.length > 0 && effectivePkg !== pkg) {
      // The requested package already failed this session and was swapped for a
      // pinned fallback (or none) — leave a breadcrumb so field logs explain the
      // swap instead of silently routing to a different recognizer.
      logEventRef.current('pkg.substituted', { requested: pkg, used: effectivePkg });
      // Stage the pinned fallback for persist-on-first-result so a stale bad
      // saved pkg (e.g. a rogue recognizer like com.anthropic.claude that's
      // still in AsyncStorage) gets OVERWRITTEN once this engine actually works.
      // Without this, the bad pkg is retried + fails every session and churns
      // through failover, because the working fallback was never persisted.
      if (effectivePkg && isPinnedRecognizer(effectivePkg)) {
        pendingPersistRef.current = {
          pkg: effectivePkg,
          label: labelForPackage(effectivePkg),
        };
      }
    }
    if (effectivePkg === null) {
      if (!detectionRanRef.current) {
        await triggerDetectionRef.current();
      } else {
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        showErrRef.current(NO_SERVICE_MESSAGE, 0, true, 'no-service');
      }
      return;
    }
    lastAttemptedPkgRef.current = effectivePkg;
    const lang = await pickBestLocale(effectivePkg);
    // Session was stopped/flushed while we were awaiting locale — abort the
    // pending start so we don't open the mic with no active session. (Dropped
    // the `&& activeEngineRef==='ondevice'` qualifier: stopAndFlush clears the
    // engine ref, and only on-device starts reach here anyway.)
    if (!pressActiveRef.current) return;
    logEventRef.current('start.request', { pkg: effectivePkg, lang });
    try {
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        maxAlternatives: 1,
        continuous: true,
        androidRecognitionServicePackage: effectivePkg,
        androidIntentOptions: { EXTRA_LANGUAGE_MODEL: SODA_DICTATION_MODEL },
      });
      started.current = true;
      setIsListening(true);
      startPulse();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      startWatchdogRef.current();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logEventRef.current('start.throw', { msg });
      sessionFailedPkgsRef.current.add(effectivePkg);
      showErrRef.current(`STT start failed: ${msg}`, 0, true);
    }
  });

  // Detection flow — called from error handler (inside effect), so use ref
  const triggerDetectionRef = useRef(async () => {
    setDetecting(true);
    // Fresh detection supersedes any persist staged by a prior auto-select.
    pendingPersistRef.current = null;
    showErrRef.current(`Scanning ${KNOWN_RECOGNIZERS.length} speech services…`, 20000);
    try {
      const available = await detectAvailableRecognizers();
      setDetecting(false);
      setErrMsg('');
      detectionRanRef.current = true;

      // A result of "only System Default" means the legacy probe didn't surface
      // any real package — System Default is appended unconditionally. Treating
      // that as a successful detection causes the app to auto-start with no
      // explicit pkg, which is exactly what just failed — an infinite loop.
      // Skip straight to the no-service sheet (with diagnostics) instead.
      const realHits = available.filter((o) => o.pkg !== '' && !sessionFailedPkgsRef.current.has(o.pkg));

      // Prefer a known-good pinned recognizer (Google's on-device engine) over
      // any third-party RecognitionService that happens to be installed. Auto-use
      // it without a picker and queue the rest as failover. This is the fix for an
      // installed app (e.g. another assistant) registering a recognizer that
      // getSpeechRecognitionServices() surfaces but that can't actually serve STT.
      const pinnedHit = realHits.find((o) => isPinnedRecognizer(o.pkg));
      if (pinnedHit) {
        // Stage the persist rather than writing it now: we only remember this
        // recognizer once it yields a real result (see the result listener), so a
        // pinned engine that's enumerated-but-broken on some non-Google device
        // can't get persisted and then re-fail every launch. Safe to defer here
        // because auto-restart resolves a missing saved pkg back to the same
        // pinned engine (null -> firstAvailablePinned in resolveEffectivePkg).
        pendingPersistRef.current = { pkg: pinnedHit.pkg, label: pinnedHit.label };
        showErrRef.current(`Using ${pinnedHit.label}`, 1500);
        // Failover only among other pinned (Google) recognizers — never queue a
        // third-party RecognitionService that can't serve STT.
        failoverChainRef.current = pinnedFailoverChain(realHits, pinnedHit.pkg);
        await startRecognizerRef.current(pinnedHit.pkg);
        return;
      }

      if (realHits.length === 0) {
        failoverChainRef.current = [];
        showErrRef.current(NO_SERVICE_MESSAGE, 0, true, 'no-service');
        return;
      }

      if (realHits.length === 1) {
        const hit = realHits[0];
        await AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, hit.pkg);
        await AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, hit.label);
        showErrRef.current(`Using ${hit.label}`, 1500);
        failoverChainRef.current = [''];
        await startRecognizerRef.current(hit.pkg);
        return;
      }

      // Multi-service: seed the failover chain with every detected package
      // (minus the one we'll show the picker for) so that, once the user
      // picks, subsequent failures can transparently try the rest.
      // Keep the System Default sentinel ('') in the failover chain as an internal
      // last resort, but don't offer it in the picker: with the pinned-recognizer
      // hardening it no longer does a bare start (it resolves to a pinned Google
      // engine), so presenting it as a distinct "System Default" choice would mislead.
      failoverChainRef.current = available.map((o) => o.pkg);
      setPickerOptions(available.filter((o) => o.pkg !== ''));
      setPickerVisible(true);
    } catch (e: unknown) {
      setDetecting(false);
      const msg = e instanceof Error ? e.message : String(e);
      showErrRef.current(`Detection failed: ${msg}`, 0, true);
    }
  });

  useEffect(() => {
    const resultSub = ExpoSpeechRecognitionModule.addListener(
      'result',
      (event: ExpoSpeechRecognitionResultEvent) => {
        const transcript = event.results[0]?.transcript;
        logEventRef.current('result', { isFinal: event.isFinal, len: transcript?.length ?? 0 });
        audioSeenRef.current = true;
        serverDisconnectRetryRef.current = 0; // recognizer produced output — recovered
        clearWatchdogRef.current();
        // Already committed via stopAndFlush() — ignore any trailing result the
        // recognizer emits during teardown so we don't re-accumulate or fire a
        // stray non-final update after the final flush.
        if (flushedExternallyRef.current) return;
        if (!transcript) return;
        // First real transcript proves this recognizer can serve STT — commit any
        // persist staged by the pinnedHit auto-select now, so we only ever
        // remember an engine that actually works.
        if (pendingPersistRef.current) {
          const { pkg, label } = pendingPersistRef.current;
          pendingPersistRef.current = null;
          void AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, pkg).catch(() => { /* best-effort */ });
          void AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, label).catch(() => { /* best-effort */ });
        }
        // Accumulator: continuous: true emits multiple isFinal results
        // (one per utterance boundary). We collect finals and overwrite the
        // interim slot, then emit the composed text as a non-final update so
        // MainScreen shows the in-progress transcript without committing.
        // The single final commit happens in the 'end' listener (on release).
        if (event.isFinal) {
          finalSegmentsRef.current.push(transcript);
          interimRef.current = '';
        } else {
          interimRef.current = transcript;
        }
        const current = composeText();
        const display = sessionTextRef.current
          ? `${sessionTextRef.current} ${current}`
          : current;
        onTranscriptRef.current(display, false);
      }
    );
    // Lifecycle listeners. expo-speech-recognition emits these on Android;
    // if any is unsupported on iOS/older versions, addListener will still
    // return a subscription and just never fire — safe no-op.
    const lifecycleSubs = [
      ExpoSpeechRecognitionModule.addListener('start', () => {
        logEventRef.current('start');
        noServiceRetryRef.current = 0;
        errorHandlingRef.current = false;
      }),
      ExpoSpeechRecognitionModule.addListener('audiostart', () => {
        logEventRef.current('audiostart');
        audioSeenRef.current = true;
        clearWatchdogRef.current();
      }),
      ExpoSpeechRecognitionModule.addListener('audioend', () => {
        logEventRef.current('audioend');
      }),
      ExpoSpeechRecognitionModule.addListener('speechstart', () => {
        logEventRef.current('speechstart');
        audioSeenRef.current = true;
        clearWatchdogRef.current();
      }),
      ExpoSpeechRecognitionModule.addListener('speechend', () => {
        logEventRef.current('speechend');
      }),
      ExpoSpeechRecognitionModule.addListener('nomatch', () => {
        logEventRef.current('nomatch');
      }),
    ];
    const errorSub = ExpoSpeechRecognitionModule.addListener(
      'error',
      async (event: ExpoSpeechRecognitionErrorEvent) => {
        clearWatchdogRef.current();
        stopListeningRef.current();
        errorHandlingRef.current = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (event as any).code ?? -1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nativeMsg = (event as any).message;
        lastErrorRef.current = `code=${code} error=${event.error}${nativeMsg ? ' msg=' + nativeMsg : ''}`;
        logEventRef.current('error', { code, error: event.error });

        // Guard: only run detection/failover when the user is actively in a session.
        // With continuous: true, expo-speech-recognition restarts the recognizer
        // internally between utterances. The `end` handler fires first (resetting
        // pressActiveRef), then the restart error arrives — these background errors
        // must not clear the saved pkg or trigger detection, or the second tap
        // finds no service. Show a brief transient error and exit.
        if (!pressActiveRef.current) {
          // A teardown error from an external stopAndFlush() (e.g. the picker
          // Activity grabbed audio focus) — already committed; swallow it AND
          // clear the guard here, since `end` may not arrive on the error path.
          if (flushedExternallyRef.current) {
            flushedExternallyRef.current = false;
            return;
          }
          if (code !== 6 && code !== 7) { // 6/7 = silence, expected after stop
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawMsg = `${event.error}${(event as any).message ? ': ' + (event as any).message : ''} (code ${code})`;
            showErrRef.current(sttErrorMessage(code, event.error, rawMsg), 4000);
          }
          return;
        }

        // Code 11 (SERVER_DISCONNECTED) is usually a transient Soda drop, not a
        // dead recognizer. Retry the SAME engine once — BEFORE marking it failed
        // — instead of failing straight over to a possibly model-less fallback
        // (e.g. com.google.android.as with no language pack, which just returns
        // code 12 and lands on the no-service sheet). Reset on a real result.
        if (code === 11 && serverDisconnectRetryRef.current < 1 && lastAttemptedPkgRef.current) {
          serverDisconnectRetryRef.current += 1;
          errorHandlingRef.current = false;
          const retryPkg = lastAttemptedPkgRef.current;
          showErrRef.current('Reconnecting…', 1500);
          setTimeout(async () => {
            if (!pressActiveRef.current) return;
            await startRecognizerRef.current(retryPkg);
          }, 400);
          return;
        }

        if (isFailoverEligibleCode(code) && lastAttemptedPkgRef.current) {
          sessionFailedPkgsRef.current.add(lastAttemptedPkgRef.current);
        }

        // Code 7 (no-match / silence timeout) is benign — the recognizer
        // heard nothing during its window. Restart silently during an active
        // session instead of entering failover or the no-service handler.
        if (code === 7) {
          errorHandlingRef.current = false;
          setTimeout(async () => {
            if (!pressActiveRef.current) return;
            const savedPkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
            await startRecognizerRef.current(savedPkg);
          }, 300);
          return;
        }

        // 1. Failover: try the next candidate in the chain before giving up
        //    or re-running detection. Applies to language/server-availability
        //    errors AND no-service errors (5) — a picker-driven selection
        //    that fails should silently try the next queued candidate rather
        //    than bouncing back through detection to the same picker.
        if (isFailoverEligibleCode(code) && failoverChainRef.current.length > 0) {
          const nextPkg = failoverChainRef.current.shift()!;
          // '' is the terminal sentinel: resolveEffectivePkg maps it back to a
          // pinned engine, so it only does anything if a pinned pkg has since
          // recovered this session; otherwise it no-ops into the no-service
          // sheet. Intentionally kept in the chain, not dead code.
          const label = nextPkg ? labelForPackage(nextPkg) : 'System Default';
          showErrRef.current(`Retrying with ${label}…`, 2000);
          await startRecognizerRef.current(nextPkg);
          return;
        }

        // 2. No-service / not-allowed errors — detect-or-clear flow
        //    code 5 = client error (no service),
        //    code 9 = service-not-allowed (Android 13+ bind restriction)
        if (code === 5 || code === 9) {
          const [savedPkg, savedLabel] = await Promise.all([
            AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY),
            AsyncStorage.getItem(STT_RECOGNIZER_LABEL_KEY),
          ]);
          if (savedPkg === null && savedLabel === null) {
            await triggerDetectionRef.current();
            return;
          }
          if (savedPkg === null && savedLabel !== null) {
            // Stale label with no pkg (e.g. user previously picked System Default,
            // which clears pkg but sets label). Clear it and re-detect fresh.
            await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
            await triggerDetectionRef.current();
            return;
          }
          // Android 16: after a continuous session ends, Soda's service is briefly
          // mid-teardown and returns ERROR_CLIENT (code 5) on immediate re-start.
          // Retry once after 700ms before wiping state and running detection.
          if (noServiceRetryRef.current < 1) {
            noServiceRetryRef.current += 1;
            await new Promise<void>(r => setTimeout(r, 700));
            if (!pressActiveRef.current) return;
            await startRecognizerRef.current(savedPkg);
            return;
          }
          noServiceRetryRef.current = 0;
          await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
          await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
          await triggerDetectionRef.current();
          return;
        }

        // 3. Failover-eligible code but chain is empty. If detection hasn't
        //    run this session, a fresh scan may surface more candidates;
        //    also clear the saved pkg since it just failed.
        if (isFailoverEligibleCode(code) && !detectionRanRef.current) {
          await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
          await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
          await triggerDetectionRef.current();
          return;
        }

        // 4. Language-specific final error — chain exhausted, detection ran
        if (code === 11 || code === 12) {
          showErrRef.current(
            'English voice model not installed on any speech service.\nOpen Speech Services by Google to download it.',
            0, true, 'lang-unavailable',
          );
          return;
        }

        // 4.5. Any other failover-eligible code (e.g. -1, the native
        //    catch-all for an absent pinned recognizer, or 13) that reaches
        //    here has an exhausted chain AND detection already ran this
        //    session — same terminal state as branch 3 above, just arrived
        //    at after detection instead of before it. Show the same
        //    no-service sheet instead of falling through to the generic
        //    per-code message below, which has no recovery action.
        if (isFailoverEligibleCode(code)) {
          showErrRef.current(NO_SERVICE_MESSAGE, 0, true, 'no-service');
          return;
        }

        // 5. Generic friendly error for everything else
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawMsg = `${event.error}${(event as any).message ? ': ' + (event as any).message : ''} (code ${code})`;
        const friendlyMsg = sttErrorMessage(code, event.error, rawMsg);
        // Only truly transient errors auto-dismiss (6=no speech, 8=busy)
        const persist = ![6, 8].includes(code);
        showErrRef.current(friendlyMsg, 8000, persist);
      }
    );
    const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
      logEventRef.current('end');
      clearWatchdogRef.current();
      const text = composeText();

      // KNOWN EDGE (deferred): a native `end` for a flushed/stopped session can
      // arrive AFTER a new session has started — the picker that triggers
      // stopAndFlush backgrounds the app and delays `end`. flushedExternallyRef
      // is reset at session start to self-heal, which leaves a small window where
      // a stale `end` could be misread as the new session's. A session epoch would
      // close it (bump a sessionEpochRef at each start, capture it per start(),
      // and bail here if it has moved), but that needs threading through the
      // result/end/error listeners plus on-device verification, so it's deferred.
      // Low probability in practice: stopOnDevice() usually delivers `end` before
      // the user can return from the picker and re-tap.

      // Tap-to-toggle: if user hasn't tapped stop yet (pressActiveRef still
      // true), Soda ended on its own (silence/timeout). Accumulate the text
      // from this segment and auto-restart after a brief delay.
      if (pressActiveRef.current && activeEngineRef.current === 'ondevice') {
        if (errorHandlingRef.current) return;
        if (text) {
          sessionTextRef.current = sessionTextRef.current
            ? `${sessionTextRef.current} ${text}`
            : text;
        }
        resetAccumulator();
        started.current = false;
        setIsListening(false);
        stopPulse();
        setTimeout(async () => {
          if (!pressActiveRef.current) return;
          const savedPkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
          await startRecognizerRef.current(savedPkg);
        }, 500);
        return;
      }

      // Already committed by an external stopAndFlush() — just tear down,
      // don't emit the transcript a second time.
      if (flushedExternallyRef.current) {
        flushedExternallyRef.current = false;
        sessionTextRef.current = '';
        resetAccumulator();
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        if (maxDurationTimer.current) {
          clearTimeout(maxDurationTimer.current);
          maxDurationTimer.current = null;
        }
        stopListeningRef.current();
        return;
      }

      // User tapped stop (or max-duration) — send accumulated + final.
      const finalText = composeFlush(sessionTextRef.current, text);
      if (finalText) onTranscriptRef.current(finalText, true);
      sessionTextRef.current = '';
      resetAccumulator();
      pressActiveRef.current = false;
      activeEngineRef.current = null;
      if (maxDurationTimer.current) {
        clearTimeout(maxDurationTimer.current);
        maxDurationTimer.current = null;
      }
      stopListeningRef.current();
    });

    return () => {
      resultSub.remove();
      errorSub.remove();
      endSub.remove();
      lifecycleSubs.forEach((s) => s.remove());
      clearWatchdogRef.current();
      if (started.current) ExpoSpeechRecognitionModule.stop();
    };
  }, []);

  const handlePickRecognizer = async (option: RecognizerOption) => {
    setPickerVisible(false);
    if (option.pkg) {
      await AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, option.pkg);
    } else {
      await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
    }
    await AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, option.label);
    // Remove the picked package from the failover chain so we don't retry it
    // immediately if it fails — next-best candidates remain queued.
    failoverChainRef.current = failoverChainRef.current.filter(
      (p) => p !== option.pkg,
    );
    showErrRef.current(`Using ${option.label}`, 1500);
    // Arm the same session state handlePressIn would set so the 3-min safety cap
    // and stop-tap routing apply to picker-started sessions too. Picker is on-device only.
    pressActiveRef.current = true;
    activeEngineRef.current = 'ondevice';
    clearMaxTimer();
    maxDurationTimer.current = setTimeout(() => {
      maxDurationTimer.current = null;
      if (pressActiveRef.current) {
        logEventRef.current('recording.max-duration');
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        stopOnDevice();
      }
    }, MAX_RECORDING_MS);
    await startRecognizerRef.current(option.pkg || null);
  };

  const requestRecordAudio = useCallback(async (): Promise<boolean> => {
    try {
      const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      if (current.granted) return true;
      if (!current.canAskAgain) return false;
      const next = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      return next.granted;
    } catch {
      return false;
    }
  }, []);

  // ── On-device recording (Android SpeechRecognizer) ──────────────────────

  const startOnDevice = useCallback(async () => {
    setErrMsg('');
    const granted = await requestRecordAudio();
    if (!pressActiveRef.current) return;
    if (!granted) {
      showErrRef.current(
        'Microphone permission is required for voice input.\nIf the system dialog did not appear, enable it manually in App Settings.',
        0, true, 'permission',
      );
      return;
    }
    const pkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
    if (!pressActiveRef.current) return;
    failoverChainRef.current = [];
    detectionRanRef.current = false;
    resetAccumulator();
    await startRecognizerRef.current(pkg);
  }, [requestRecordAudio, resetAccumulator]);

  const stopOnDevice = useCallback(() => {
    // The 'end' listener flushes the composed transcript, so we just need to
    // ask Soda to wrap up. stopListening() is called from the end listener.
    if (started.current) {
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* ignore */ }
    } else {
      // Race: user released before Soda started. Nothing to flush; clear.
      resetAccumulator();
    }
  }, [resetAccumulator]);

  // ── External stop+flush (parent calls this before opening a picker etc.) ──
  // Commits the in-progress transcript as final NOW (synchronously, from JS
  // state) rather than relying on the native `end` round-trip, which can be
  // suspended when the picker Activity backgrounds the app — the exact path
  // that was dropping the partial. No-op when not recording.
  const stopAndFlush = useCallback(() => {
    if (!pressActiveRef.current) {
      logEventRef.current('flush.noop', { reason: 'not-active' });
      return;
    }
    clearMaxTimer();
    // Tear the session down BEFORE running any parent code below, so a throw
    // from onTranscript can't strand the mic or wedge pressActiveRef.
    pressActiveRef.current = false;
    activeEngineRef.current = null;
    const text = composeFlush(sessionTextRef.current, composeText());
    // Diagnostics: len=0 means STT captured no transcript to flush (e.g. a Soda
    // nomatch), NOT that the flush dropped it. session = chars already folded
    // from prior auto-restarted segments.
    logEventRef.current('flush.ondevice', {
      len: text.length,
      session: sessionTextRef.current.length,
    });
    flushedExternallyRef.current = true; // suppress the end-listener re-commit
    sessionTextRef.current = '';
    resetAccumulator();
    stopOnDevice(); // release the mic; `end` fires and short-circuits on the flag
    // Emit LAST and contained: teardown is done and the mic is released, so a
    // throwing parent callback can't leave the recognizer running.
    if (text) {
      try {
        onTranscriptRef.current(text, true);
        logEventRef.current('flush.emit', { len: text.length });
      } catch (e: unknown) {
        logEventRef.current('flush.emit.throw', {
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      logEventRef.current('flush.empty');
    }
  }, [composeText, resetAccumulator, clearMaxTimer, stopOnDevice]);

  useImperativeHandle(ref, () => ({ stopAndFlush }), [stopAndFlush]);

  // ── Tap-to-toggle router (tap once to start, tap again to stop) ─────────

  const handleToggle = useCallback(async () => {
    if (detecting || disabled) return;

    // Second tap — stop recording
    if (pressActiveRef.current) {
      pressActiveRef.current = false;
      clearMaxTimer();
      const engine = activeEngineRef.current;
      activeEngineRef.current = null;
      if (engine === 'ondevice') {
        stopOnDevice();
      }
      return;
    }

    // First tap — start recording
    pressActiveRef.current = true;
    errorHandlingRef.current = false;
    sessionTextRef.current = '';
    // Self-heal the external-flush guard at the start of every session so a
    // prior session whose `end` never arrived can't make this one skip its
    // real commit.
    flushedExternallyRef.current = false;
    // Drop any persist staged by a prior session that never produced a result,
    // so this session can't accidentally commit the wrong recognizer.
    pendingPersistRef.current = null;
    serverDisconnectRetryRef.current = 0;
    errPersistRef.current = false;
    setErrMsg('');
    clearMaxTimer();
    maxDurationTimer.current = setTimeout(() => {
      maxDurationTimer.current = null;
      if (pressActiveRef.current) {
        logEventRef.current('recording.max-duration');
        pressActiveRef.current = false;
        stopOnDevice();
        activeEngineRef.current = null;
      }
    }, MAX_RECORDING_MS);

    if (!pressActiveRef.current) return;
    activeEngineRef.current = 'ondevice';
    await startOnDevice();
  }, [detecting, disabled, clearMaxTimer, stopOnDevice, startOnDevice]);

  return (
    <View>
      {/* Recognizer picker sheet */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
      >
        <Pressable style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.7)' }]} onPress={() => setPickerVisible(false)}>
          <View style={[styles.sheet, { backgroundColor: theme.colors.surface }]}>
            <Text style={[styles.sheetTitle, { color: theme.colors.onSurface }]}>Choose voice recognizer</Text>
            <Text style={[styles.sheetSub, { color: theme.colors.onSurfaceVariant }]}>Multiple speech services found on this device</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {pickerOptions.map(opt => (
                <Pressable key={opt.pkg} style={[styles.sheetOption, { marginBottom: 12, backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={() => handlePickRecognizer(opt)}>
                  <Text style={[styles.sheetOptionLabel, { color: theme.colors.onSurface }]}>{opt.label}</Text>
                  <Text style={[styles.sheetOptionPkg, { color: theme.colors.onSurfaceVariant }]}>{opt.pkg}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* Error / status popup sheet */}
      <Modal
        visible={errMsg.length > 0}
        transparent
        animationType="slide"
        onRequestClose={dismissErr}
      >
        <Pressable
          style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.7)' }]}
          onPress={errPersist ? undefined : dismissErr}
        >
          <Pressable style={[styles.sheet, { backgroundColor: theme.colors.surface }]} onPress={() => {}}>
            <Text style={[styles.errSheetTitle, { color: theme.colors.onSurface }]}>
              {errPersist ? '⚠️ Voice Input' : 'ℹ️ Voice Input'}
            </Text>
            <ScrollView style={styles.errSheetScroll} showsVerticalScrollIndicator={false}>
            {errAction === 'diag' ? (
              <ScrollView style={[styles.diagScroll, { backgroundColor: theme.colors.background }]}>
                <Text style={[styles.diagText, { color: theme.colors.onSurfaceVariant }]}>{errMsg}</Text>
              </ScrollView>
            ) : (
              <Text style={[styles.errSheetMsg, { color: theme.colors.onSurface }]}>{errMsg}</Text>
            )}
            {errAction === 'permission' && (
              <View style={styles.errActions}>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={openAppSettings}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Open App Settings</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Grant Microphone permission manually</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={dismissErr}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Try Again</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>After enabling permission, tap mic</Text>
                </Pressable>
              </View>
            )}
            {errAction === 'lang-unavailable' && (
              <View style={styles.errActions}>
                <Pressable
                  style={[styles.errActionBtn, { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary, opacity: downloadingModel ? 0.6 : 1 }]}
                  onPress={handleDownloadModel}
                  disabled={downloadingModel}
                >
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onPrimary }]}>{downloadingModel ? 'Downloading…' : 'Download voice model'}</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onPrimary }]}>Pull the English model on-device — no Play Store trip</Text>
                </Pressable>
                <Pressable
                  style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                  onPress={() => openPlayStore('com.google.android.tts')}
                >
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Open Speech Services by Google</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Download the English voice model</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={retryDetection}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>After downloading, rescan devices</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={copyDiagnostics}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy diagnostics</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Paste the scan + probe output into a bug report</Text>
                </Pressable>
              </View>
            )}
            {errAction === 'no-service' && (
              <View style={styles.errActions}>
                <Pressable
                  style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                  onPress={() => openPlayStore('com.google.android.tts')}
                >
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Install Speech Services by Google</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>com.google.android.tts — provides on-device STT</Text>
                </Pressable>
                <Pressable
                  style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                  onPress={() => openPlayStore('com.samsung.android.bixby.agent')}
                >
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Install Samsung Bixby</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>com.samsung.android.bixby.agent</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={retryDetection}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Rescan device for speech services</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={copyDiagnostics}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy diagnostics</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Paste the scan + probe output into a bug report</Text>
                </Pressable>
              </View>
            )}
            {errAction === 'diag' && (
              <View style={styles.errActions}>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={copyDiagnostics}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy again</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Writes the dump above to the clipboard</Text>
                </Pressable>
                <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={retryDetection}>
                  <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                  <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Rescan device for speech services</Text>
                </Pressable>
              </View>
            )}
            </ScrollView>
            <Pressable style={[styles.errSheetBtn, { backgroundColor: theme.colors.primary }]} onPress={dismissErr}>
              <Text style={[styles.errSheetBtnText, { color: theme.colors.onPrimary }]}>
                {errAction === 'none' ? 'Got it' : 'Dismiss'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={styles.orbContainer}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <Pressable
            onPress={handleToggle}
            disabled={disabled || detecting}
            style={({ pressed }: { pressed: boolean }) => [
              styles.btn,
              { borderColor: theme.colors.outline, backgroundColor: theme.colors.surface },
              pressed && { backgroundColor: theme.colors.surfaceVariant },
              // Solid-fill CTA while recording: the deep teal (carnet.fill),
              // not colors.primary — on dark, primary is the brightened text
              // tone and reads wrong as a fill (DESIGN.md).
              isListening && { backgroundColor: theme.carnet.fill, borderColor: theme.carnet.fill },
              (disabled || detecting) && styles.btnDisabled,
            ]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <Icon
              source={detecting ? 'dots-horizontal' : isListening ? 'stop' : 'microphone'}
              size={22}
              color={isListening ? theme.carnet.onFill : theme.colors.primary}
            />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
});

VoiceButton.displayName = 'VoiceButton';

const styles = StyleSheet.create({
  btn: {
    width: MIN_TAP_TARGET, height: MIN_TAP_TARGET,
    borderRadius: MIN_TAP_TARGET / 2,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.35 },
  orbContainer: {
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errSheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  errSheetMsg: { fontSize: 15, lineHeight: 22 },
  diagScroll: { maxHeight: 300, borderRadius: 8, padding: 10 },
  diagText: { fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
  errSheetBtn: {
    marginTop: 16, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  errSheetBtnText: { fontSize: 16, fontWeight: '700' },
  errActions: { gap: 10, marginTop: 12 },
  errActionBtn: {
    borderRadius: 10, padding: 14,
    borderWidth: 1,
  },
  errActionBtnText: { fontSize: 15, fontWeight: '600' },
  errActionBtnSub: { fontSize: 12, marginTop: 3 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 24, paddingBottom: 40, gap: 12, maxHeight: '85%',
  },
  errSheetScroll: {},
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  sheetSub: { fontSize: 13, marginBottom: 4 },
  sheetOption: {
    borderRadius: 10, padding: 16,
    borderWidth: 1,
  },
  sheetOptionLabel: { fontSize: 15, fontWeight: '600' },
  sheetOptionPkg: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
});
