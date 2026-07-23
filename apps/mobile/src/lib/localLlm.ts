/**
 * Local-LLM client for carnet — an OpenAI-compatible HTTP client aimed at a
 * loopback/LAN server (Relais by default, or any other OpenAI-compatible
 * local deployment) instead of OmniRoute's cloud-routed proxy. Structurally
 * mirrors omniroute.ts (same function signatures, same error-classification
 * contract via the shared HttpError base — see the isPermanentError/
 * isNotConfiguredError generalization in omniroute.ts) so dispatcher.ts can
 * route to either backend transparently.
 *
 * Divergences from omniroute.ts, all deliberate (see
 * .claude/PRPs/plans/local-llm-backend.plan.md):
 *   - Blank localLlmUrl defaults to http://127.0.0.1:8080 rather than
 *     throwing not-configured — the whole point is a zero-setup disconnected
 *     flow (Relais already runs on-device with no user action required).
 *   - One model field (localLlmModel) covers text AND vision — no separate
 *     vision-model split like OmniRoute's chat/vision divide.
 *   - No auto-fallback to OmniRoute on failure — selecting "local" is
 *     exclusive by design (privacy: a disconnected user's capture should
 *     never silently reach the cloud proxy).
 *   - transcribeAudio/autoTranscribeIfEnabled are NOT implemented here —
 *     they're already backend-agnostic (on-device speech recognition,
 *     omniroute.ts:663-731) and dispatcher.ts routes them to omniroute.ts
 *     unconditionally regardless of the selected backend.
 */

import { sanitizeAndNormalize, sanitizeMarkdown, type NoteType } from "./enrichSanitize";
import { getPromptOverrides, getSettings } from "./settings";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
  type PromptPair,
} from "./prompts";
import { isCredentialSafeUrl } from "./netAllowlist";
import {
  HttpError,
  parseErrorBody,
  sanitizeErrorMessage,
  withTimeout,
} from "./httpClient";
import { fetchUrlPreview, type UrlPreview } from "./urlpreview";
import { withSystemOverride, type EnrichResult } from "./omniroute";

export type { EnrichResult };

/** Default base URL when localLlmUrl is blank — Relais's unauthenticated
 * loopback port. Unlike OmniRoute, a blank URL is a valid, expected state
 * (zero-setup disconnected flow), not a not-configured error. */
const DEFAULT_LOCAL_LLM_URL = "http://127.0.0.1:8080";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

interface OpenAIChoice {
  message: OpenAIMessage;
}

interface OpenAIResponse {
  model?: string;
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

/** Error thrown by the local-LLM client. Extends the shared HttpError base
 * (see httpClient.ts) so isPermanentError/isNotConfiguredError — generalized
 * in omniroute.ts to check HttpError rather than OmniRouteError specifically
 * — classify these correctly without dispatcher.ts needing backend-aware
 * predicates. Mirrors KarakeepError's identical precedent (karakeep.ts:34). */
export class LocalLlmError extends HttpError {
  constructor(message: string, status: number, opts?: { notConfigured?: boolean }) {
    super(message, status, opts);
    this.name = "LocalLlmError";
  }
}

/** Re-exported for callers that want backend-specific predicates directly
 * (dispatcher.ts uses the generalized omniroute.ts versions instead, which
 * work for either backend — these are here for symmetry/direct-import
 * callers and for this file's own tests). */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.status >= 400 && err.status < 500;
}

export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof HttpError && err.notConfigured;
}

const FETCH_TIMEOUT_MS = 20_000;

function localLlmTimeoutError(ms: number): LocalLlmError {
  return new LocalLlmError(
    `Local LLM unreachable — timed out after ${Math.round(ms / 1000)}s.`,
    0,
  );
}

function assertHttpsOrLocal(trimmed: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
  throw new LocalLlmError(
    "Local LLM URL must use https:// (or be a loopback/LAN address) to protect the API key",
    0,
  );
}

/** Strip a leading ``` fence (and matching trailer) — identical logic to
 * omniroute.ts's stripCodeFences; duplicated rather than imported since
 * omniroute.ts doesn't export it (it's a private helper there too). */
function stripCodeFences(raw: string): string {
  const leftTrimmed = raw.trimStart();
  if (!leftTrimmed.startsWith("```")) return raw;
  const rest = leftTrimmed.slice(3);
  const afterLang = rest.includes("\n") ? rest.slice(rest.indexOf("\n") + 1) : rest;
  const stripped = afterLang.trimEnd().endsWith("```")
    ? afterLang.trimEnd().slice(0, -3).trimEnd()
    : afterLang;
  return stripped;
}

async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  noteType: NoteType,
): Promise<EnrichResult> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(
        `Local LLM error — ${await parseErrorBody(response)}`,
        response.status,
      );
    }

    const json = (await response.json()) as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim().length) {
      throw new LocalLlmError("Local LLM returned an empty or malformed response", response.status);
    }

    const stripped = stripCodeFences(content);
    const markdown = sanitizeAndNormalize(stripped, noteType) ?? sanitizeMarkdown(stripped);
    const modelUsed = json.model ?? model;
    return { markdown, model: modelUsed };
  });
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: PromptPair,
  noteType: NoteType,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages, noteType);
}

async function getBaseUrl(): Promise<string> {
  const settings = await getSettings();
  const url = settings.localLlmUrl.trim();
  return url || DEFAULT_LOCAL_LLM_URL;
}

async function getApiKey(): Promise<string> {
  const settings = await getSettings();
  return settings.localLlmApiKey ?? "";
}

/** Single model for text AND vision — see the file header's divergence
 * note. Unlike omniroute's getModel(), a blank model IS surfaced as
 * not-configured (there's no sensible hard-coded default for an arbitrary
 * local deployment the way "openrouter/openai/gpt-4o-mini" is a sensible
 * OmniRoute default). */
async function getModel(): Promise<string> {
  const settings = await getSettings();
  const model = settings.localLlmModel.trim();
  if (!model) {
    throw new LocalLlmError("Local LLM model not configured — set it in Settings", 0, {
      notConfigured: true,
    });
  }
  return model;
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const url = `${trimmed}/v1/models`;

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(`Local LLM error — ${await parseErrorBody(response)}`, response.status);
    }

    const json = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return [...new Set(ids)].sort();
  });
}

/** Reachability check for the Settings screen's "Test Connection" button.
 * Never throws — returns false on any failure (timeout, network error,
 * non-2xx). Confirmed unauthenticated on both of Relais's ports, so no
 * Authorization header is sent. Deliberately does NOT go through
 * assertHttpsOrLocal/isCredentialSafeUrl's throw-on-unsafe-URL path — a
 * connectivity CHECK should report false for an unsafe URL, not throw and
 * crash the button handler. */
export async function healthCheck(baseUrl: string): Promise<boolean> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  if (!isCredentialSafeUrl(trimmed)) return false;
  try {
    return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
      const response = await fetch(`${trimmed}/health`, { method: "GET", signal });
      return response.ok;
    });
  } catch {
    return false;
  }
}

// ── Public API — mirrors omniroute.ts's shape exactly ──────────────────────

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(buildIdeaPrompt(text), overrides.idea);
  return chatCompletion(baseUrl, apiKey, model, pair, "idea");
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildJournalPrompt(input.transcript, input.notes),
    overrides.journal,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "journal");
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildPersonPrompt(input.ocrResult, input.context),
    overrides.person,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "person");
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const { system: defaultSystem, userText } = buildSharedImagePrompt(input.context);
  const systemOverride = overrides.sharedImage?.trim() ?? "";
  const system = systemOverride || defaultSystem;
  const dataUrl = `data:${safeMime};base64,${input.base64}`;
  const messages: OpenAIMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  return executeChat(baseUrl, apiKey, model, messages, "shared");
}

const OCR_CARD_PROMPT =
  "Transcribe ALL text on this business card exactly as printed. Preserve every field: name, title, company, phone numbers, email addresses, websites, physical address, and any other text. Output plain text, one field per line. Do not invent, omit, or normalize anything.";

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const [baseUrl, apiKey, model] = await Promise.all([getBaseUrl(), getApiKey(), getModel()]);
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const dataUrl = `data:${safeMime};base64,${input.base64}`;
  const messages: OpenAIMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: OCR_CARD_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false, temperature: 0 });

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(`Local LLM error — ${await parseErrorBody(response)}`, response.status);
    }

    const json = (await response.json()) as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new LocalLlmError("Local LLM response contained no OCR text", response.status);
    }
    return { text };
  });
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const previewPromise: Promise<UrlPreview | null> = input.url
    ? fetchUrlPreview(input.url)
    : Promise.resolve(null);
  if (input.onPreviewSettled) {
    const fireSettled = (): void => {
      try {
        input.onPreviewSettled?.();
      } catch {
        // swallow — caller's UI state is best-effort
      }
    };
    void previewPromise.then(fireSettled, fireSettled);
  }
  const [baseUrl, apiKey, model, preview, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    previewPromise,
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildSharedLinkPrompt(input.url, input.text, input.context, preview),
    overrides.sharedLink,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "shared");
}

export async function promoteIdea(
  currentMarkdown: string,
  target: Parameters<typeof buildPromoteIdeaPrompt>[1],
): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([getBaseUrl(), getApiKey(), getModel()]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildPromoteIdeaPrompt(currentMarkdown, target),
    "idea",
  );
}
