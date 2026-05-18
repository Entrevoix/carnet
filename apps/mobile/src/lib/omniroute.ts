/**
 * OmniRoute LLM chat client for carnet v0.2.
 *
 * Posts to the OpenAI-compatible `/v1/chat/completions` endpoint at the
 * configured OmniRoute base URL. Reads `omniRouteUrl`, `omniRouteApiKey`,
 * and `omniRouteModel` from settings.
 *
 * Each method corresponds to one capture mode:
 *   enrichIdea    — raw thought → structured Obsidian markdown
 *   enrichJournal — voice transcript → journal entry
 *   enrichPerson  — OCR business card + context → contact note
 *   promoteIdea   — rewrite an existing idea at a higher maturity status
 */

import { getSettings } from "./settings";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
  type PromptPair,
} from "./prompts";
import type { IdeaStatus } from "@carnet/shared";

export interface EnrichResult {
  markdown: string;
  model: string;
}

/** OpenAI-compatible content part for multimodal messages. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  /** String for text-only, array for multimodal (image + text). */
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

/**
 * Error thrown by the OmniRoute client. Carries the HTTP status so callers
 * can classify between transient (network / 5xx — safe to queue and retry)
 * and permanent (4xx — auth / bad model / malformed request — surface to
 * user, do NOT retry blindly). Status `0` means a network-level failure
 * (DNS, TLS, connection refused, abort).
 */
export class OmniRouteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OmniRouteError";
    this.status = status;
  }
}

/** True for HTTP statuses that indicate a permanent failure — caller should
 * NOT enqueue these for automatic retry. */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof OmniRouteError)) return false;
  return err.status >= 400 && err.status < 500;
}

const FETCH_TIMEOUT_MS = 60_000;

/** Strip any "Bearer ..." substring from an error message so the API key
 * never lands in stored error logs or on-screen toasts. Also strip the
 * Authorization header form just in case. */
function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/**
 * Low-level POST to /v1/chat/completions. Sends arbitrary OpenAI-compatible
 * messages — text or multimodal. Used both for the text-only modes
 * (idea/journal/person) and for vision-enabled share-target enrichment.
 *
 * stream: false is REQUIRED. OmniRoute (LiteLLM-style proxy) defaults to
 * text/event-stream even when stream is omitted. RN's fetch then hangs on
 * `await response.json()` because the SSE body never closes into a parseable
 * JSON document.
 */
async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
): Promise<EnrichResult> {
  // Enforce HTTPS. An http:// URL would leak the bearer token in cleartext.
  // Allow http://localhost / 127.0.0.1 / 10.x for dev convenience.
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|10\.)/i.test(trimmed);
    if (!isLocal) {
      throw new OmniRouteError(
        "OmniRoute URL must use https:// to protect the API key",
        0,
      );
    }
  }

  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    const raw = e instanceof Error ? e.message : String(e);
    const msg = sanitizeErrorMessage(raw);
    throw new OmniRouteError(`OmniRoute network error — ${msg}`, 0);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as OpenAIResponse;
      if (errBody.error?.message) {
        detail += `: ${sanitizeErrorMessage(errBody.error.message)}`;
      }
    } catch {
      // ignore parse failure — original status message is enough
    }
    throw new OmniRouteError(`OmniRoute error — ${detail}`, response.status);
  }

  const json = (await response.json()) as OpenAIResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim().length) {
    throw new OmniRouteError(
      "OmniRoute returned an empty or malformed response",
      response.status,
    );
  }

  const markdown = stripCodeFences(content);
  const modelUsed = json.model ?? model;
  return { markdown, model: modelUsed };
}

/**
 * Text-only chat completion. Builds [system, user] from a PromptPair and
 * delegates to executeChat. Used for the idea / journal / person modes.
 */
async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: PromptPair,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages);
}

/** Strip a leading ``` fence (and matching trailer). Does not trim unfenced content. */
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

async function getBaseUrl(): Promise<string> {
  const settings = await getSettings();
  const url = settings.omniRouteUrl.trim();
  if (!url) {
    throw new OmniRouteError(
      "OmniRoute URL not configured — set it in Settings",
      0,
    );
  }
  return url;
}

async function getApiKey(): Promise<string> {
  const settings = await getSettings();
  return settings.omniRouteApiKey ?? "";
}

async function getModel(): Promise<string> {
  const settings = await getSettings();
  return settings.omniRouteModel.trim() || "openrouter/openai/gpt-4o-mini";
}

/**
 * Fetch the available model catalog from `${baseUrl}/v1/models`. Returns
 * the sorted list of model IDs. Same auth + HTTPS rules as chatCompletion.
 *
 * This is the network primitive behind the Settings screen's "Browse
 * models" picker — so the user can see what's actually available on their
 * OmniRoute instance instead of guessing a model name.
 */
export async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|10\.)/i.test(trimmed);
    if (!isLocal) {
      throw new OmniRouteError(
        "OmniRoute URL must use https:// to protect the API key",
        0,
      );
    }
  }

  const url = `${trimmed}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    const raw = e instanceof Error ? e.message : String(e);
    throw new OmniRouteError(
      `OmniRoute network error — ${sanitizeErrorMessage(raw)}`,
      0,
    );
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as OpenAIResponse;
      if (errBody.error?.message) {
        detail += `: ${sanitizeErrorMessage(errBody.error.message)}`;
      }
    } catch {
      // ignore parse failure
    }
    throw new OmniRouteError(`OmniRoute error — ${detail}`, response.status);
  }

  const json = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enrich a raw idea text into structured Obsidian markdown. */
export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  return chatCompletion(baseUrl, apiKey, model, buildIdeaPrompt(text));
}

/** Enrich a journal voice transcript (plus optional notes) into a journal entry. */
export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildJournalPrompt(input.transcript, input.notes),
  );
}

/** Enrich a business card OCR result + context into a contact note. */
export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildPersonPrompt(input.ocrResult, input.context),
  );
}

/**
 * Vision-enabled enrichment for an image shared into carnet. Sends the
 * image inline as a base64 data URL alongside a curator-style prompt that
 * asks the model to give the note a real title, describe what's in the
 * image, and weave in the user's context. Requires a vision-capable
 * model — most defaults on this provider (Gemini Flash, Claude Haiku,
 * openrouter/openai/gpt-4o-mini) handle images.
 */
export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  const { system, userText } = buildSharedImagePrompt(input.context);
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
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
  return executeChat(baseUrl, apiKey, model, messages);
}

/** Text-only enrichment for a URL or raw text shared into carnet. */
export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildSharedLinkPrompt(input.url, input.text, input.context),
  );
}

/**
 * Rewrite an existing idea note to reflect a new status level.
 * Returns the updated markdown and the model used.
 */
export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
  ]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildPromoteIdeaPrompt(currentMarkdown, target),
  );
}
