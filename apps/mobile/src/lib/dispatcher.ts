/**
 * Enrichment backend dispatcher (Stage 2 / branch B7, extended for the
 * local-LLM backend).
 *
 * The single seam through which callers reach the eight backend-divergent
 * enrichment functions, decoupling them from any one concrete backend.
 * `Settings.llmBackend` selects which backend serves a capture — read fresh
 * on EVERY call (not cached), so a user flipping the picker mid-session
 * takes effect on their very next capture.
 *
 * transcribeAudio/autoTranscribeIfEnabled/isPermanentError/
 * isNotConfiguredError/EnrichResult stay static re-exports from omniroute.ts
 * — they're backend-agnostic (transcription is on-device speech recognition
 * regardless of llmBackend; the error predicates were generalized in
 * omniroute.ts to classify via the shared HttpError base, so they work for
 * either backend's error class without a switch here).
 *
 * "on-device" (native Gemma inference) has no implementation yet and no
 * Settings UI picker entry — routing to it throws a clear error rather than
 * silently falling back, so a stray/malformed persisted value fails loudly
 * instead of masquerading as one of the two real backends.
 */

import { getSettings, type LlmBackend } from "./settings";
import * as omniroute from "./omniroute";
import * as localLlm from "./localLlm";
import type { EnrichResult } from "./omniroute";

export {
  transcribeAudio,
  autoTranscribeIfEnabled,
  isPermanentError,
  isNotConfiguredError,
} from "./omniroute";
export type { EnrichResult } from "./omniroute";

type DivergentBackend = typeof omniroute | typeof localLlm;

function backendFor(backend: LlmBackend): DivergentBackend {
  if (backend === "local") return localLlm;
  if (backend === "omniroute") return omniroute;
  throw new Error(`Backend "${backend}" has no implementation yet`);
}

async function currentBackend(): Promise<DivergentBackend> {
  const settings = await getSettings();
  return backendFor(settings.llmBackend);
}

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichIdea(text);
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichJournal(input);
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichPerson(input);
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichSharedImage(input);
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichSharedLink(input);
}

export async function promoteIdea(
  currentMarkdown: string,
  target: Parameters<typeof omniroute.promoteIdea>[1],
): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.promoteIdea(currentMarkdown, target);
}

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const backend = await currentBackend();
  return backend.ocrCardViaVision(input);
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const backend = await currentBackend();
  return backend.listModels(baseUrl, apiKey);
}
