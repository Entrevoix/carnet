/**
 * Enrichment backend dispatcher (Stage 2 / branch B7; rewritten for the LLM
 * provider list Phase 1 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md).
 *
 * The single seam through which callers reach the backend-divergent
 * enrichment functions, decoupling them from any one concrete provider.
 * `Settings.llmBackend` selects which provider serves a capture — read fresh
 * on EVERY call (not cached), so a user flipping the picker mid-session
 * takes effect on their very next capture.
 *
 * Previously this module imported two whole duplicate client modules
 * (omniroute.ts, localLlm.ts) and swapped between them. Both are now merged
 * into llmClient.ts, ONE OpenAI-compatible client parameterized by a
 * ProviderConfig this module resolves from settings. `buildConfig` is where
 * each backend's distinct defaulting behavior lives now: OmniRoute's blank
 * URL is not-configured but its blank model falls back to a hard-coded
 * default; the local backend's blank URL falls back to the loopback default
 * but its blank model is not-configured. llmClient.ts itself no longer knows
 * about backends at all — it just throws not-configured on whatever field
 * arrives blank.
 *
 * transcribeAudio/autoTranscribeIfEnabled live here directly (not in
 * llmClient.ts) because they're backend-agnostic on-device speech
 * recognition that reads settings and touches the vault writer — outside
 * llmClient.ts's "reads no settings" contract, which is specifically about
 * the OpenAI-compatible chat client. isPermanentError/isNotConfiguredError
 * stay static re-exports from llmClient.ts — they classify via the shared
 * HttpError base, so they work for any provider's error without a switch
 * here.
 *
 * "on-device" (native Gemma inference) has no implementation and no
 * Settings UI picker entry — routing to it throws a clear error rather than
 * silently falling back, so a stray/malformed persisted value fails loudly
 * instead of masquerading as one of the two real backends.
 */

import { getSettings, getPromptOverrides, DEFAULT_OMNIROUTE_MODEL, type Settings } from "./settings";
import * as llmClient from "./llmClient";
import type { EnrichResult, ProviderConfig } from "./llmClient";
import {
  readNote,
  readPairedBinaryFromNote,
  updateNote,
  upsertSection,
} from "./writer";
import type { IdeaStatus } from "@carnet/shared";

// listModels is a straight re-export — it used to route through backendFor()
// like every other call here, so llmBackend === "local" would hit
// localLlm.ts's listModels (its own blank-URL-defaults-to-loopback default
// and "Local LLM ..." message branding). Now it always hits the one merged
// llmClient.listModels (OmniRoute-shaped: no blank-URL default, generic
// "LLM provider ..." messages) regardless of llmBackend — a narrowing,
// deliberately left as-is rather than special-cased. Safe in practice: the
// only real caller (SettingsScreen's model browser) always passes an
// explicit URL (form.omniRouteUrl), so the blank-URL-default path was
// already unreachable from that call site, and no test asserts on the
// message branding.
export { isPermanentError, isNotConfiguredError, listModels } from "./llmClient";
export type { EnrichResult } from "./llmClient";

/**
 * Resolve today's settings fields into the ProviderConfig llmClient.ts
 * expects, replicating each backend's exact pre-merge defaulting so this
 * refactor is behavior-preserving:
 *   - omniroute: blank URL stays blank (llmClient throws not-configured);
 *     blank model gets OmniRoute's hard-coded default (never not-configured).
 *   - local: blank URL gets the loopback default (never not-configured);
 *     blank model stays blank (llmClient throws not-configured) — there's no
 *     sensible hard-coded default for an arbitrary local deployment.
 */
function buildConfig(settings: Settings): ProviderConfig {
  if (settings.llmBackend === "local") {
    return {
      baseUrl: settings.localLlmUrl.trim() || llmClient.DEFAULT_LOCAL_LLM_URL,
      apiKey: settings.localLlmApiKey ?? "",
      model: settings.localLlmModel.trim(),
      // One model covers text AND vision for the local backend — no separate
      // vision-model split like OmniRoute's chat/vision divide.
      visionModel: settings.localLlmModel.trim(),
      // Threaded into every llmClient.ts error message so Phase 1 stays
      // byte-identical to localLlm.ts's original "Local LLM ..." wording.
      label: "Local LLM",
    };
  }
  if (settings.llmBackend === "omniroute") {
    return {
      baseUrl: settings.omniRouteUrl.trim(),
      apiKey: settings.omniRouteApiKey ?? "",
      model: settings.omniRouteModel.trim() || DEFAULT_OMNIROUTE_MODEL,
      visionModel: settings.omniRouteVisionModel.trim(),
      // Threaded into every llmClient.ts error message so Phase 1 stays
      // byte-identical to omniroute.ts's original "OmniRoute ..." wording.
      label: "OmniRoute",
    };
  }
  throw new Error(`Backend "${settings.llmBackend}" has no implementation yet`);
}

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  return llmClient.enrichIdea(text, buildConfig(settings), overrides.idea);
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  return llmClient.enrichJournal(input, buildConfig(settings), overrides.journal);
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  return llmClient.enrichPerson(input, buildConfig(settings), overrides.person);
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  return llmClient.enrichSharedImage(input, buildConfig(settings), overrides.sharedImage);
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  return llmClient.enrichSharedLink(input, buildConfig(settings), overrides.sharedLink);
}

export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
): Promise<EnrichResult> {
  const settings = await getSettings();
  return llmClient.promoteIdea(currentMarkdown, target, buildConfig(settings));
}

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const settings = await getSettings();
  return llmClient.ocrCardViaVision(input, buildConfig(settings));
}

// ── On-device speech recognition (backend-agnostic) ─────────────────────────

/** Hard cap for the audio payload sent to on-device transcription. Pre-check
 * before the transcription call so users see a friendly error instead of a
 * confusing failure from the recognizer. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/**
 * Transcribe an audio file using the on-device speech recognizer
 * (expo-speech-recognition → Google Soda on Android). Backend-agnostic —
 * doesn't route through either LLM provider — the prior chat-completion /
 * Whisper paths were swapped out after Gemini multimodal kept refusing
 * verbatim transcription via content-policy and the user's proxy didn't
 * expose a Whisper endpoint.
 *
 * On-device wins:
 *   - Free, no per-capture API cost
 *   - Private — audio never leaves the device
 *   - Works without any provider being configured / reachable
 *   - Same recognizer the Journal voice button already uses
 *
 * Caveat: requires the OS speech-recognition language pack to be
 * installed (one-time setup the user completes the first time they
 * tap any voice button — see the STT first-tap-bug memory).
 *
 * Pre-checks the 25 MB cap. Caller passes base64 (we already have it
 * from readPairedBinaryFromNote) and filename (extension matters for
 * the cache temp file's audio format detection).
 */
export async function transcribeAudio(input: {
  base64: string;
  mimeType: string;
  filename: string;
}): Promise<{ text: string; model: string }> {
  const approxBytes = Math.floor(input.base64.length * 0.75);
  if (approxBytes > MAX_TRANSCRIPTION_BYTES) {
    const mb = Math.round(approxBytes / 1024 / 1024);
    const capMb = Math.round(MAX_TRANSCRIPTION_BYTES / 1024 / 1024);
    throw new llmClient.LlmClientError(
      `Audio is ${mb} MB — transcription caps at ${capMb} MB. Split or compress before transcribing.`,
      413,
    );
  }

  // Dynamic import keeps the on-device dependency out of the
  // unit-test path (vitest can't load the native module under Node).
  // The runtime cost of the import is negligible; module cache after
  // first call.
  const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
  const text = await transcribeOnDevice({
    base64: input.base64,
    filename: input.filename,
  });
  return { text, model: "on-device" };
}

/**
 * Optional post-save hook for audio captures. When the user has flipped
 * `autoTranscribeOnSave` on in Settings, this reads the paired audio file
 * off disk, runs on-device transcription, and idempotently inserts a
 * `## Transcript` section back into the note via upsertSection.
 *
 * Best-effort by contract — NEVER throws. Returns null on success, an
 * error reason string on failure. Callers (AudioCaptureScreen,
 * ShareReceiveScreen audio branch) fire-and-forget after their saved
 * screen renders; they surface the reason in a HelperText if non-null
 * but never block the UX on a transcription failure.
 *
 * No-ops when:
 *   - autoTranscribeOnSave is false (most common path)
 *   - the note has no `../Audio/...` link (defensive)
 *   - any downstream step throws (readNote, transcribeAudio, updateNote)
 */
export async function autoTranscribeIfEnabled(
  filepath: string,
): Promise<string | null> {
  try {
    const settings = await getSettings();
    if (!settings.autoTranscribeOnSave) return null;

    const body = await readNote(filepath);
    const linkMatch = body.match(/\.\.\/Audio\/([^/\s)]+)/);
    if (!linkMatch) return "Note has no Audio/ link";
    const filename = linkMatch[1];

    const { base64, mime } = await readPairedBinaryFromNote(body);
    const { text } = await transcribeAudio({
      base64,
      mimeType: mime,
      filename,
    });
    const next = upsertSection(body, "Transcript", text);
    await updateNote(filepath, next);
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
