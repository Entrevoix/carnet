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
import { fetchUrlPreview, type UrlPreview } from "./urlpreview";
import {
  readNote,
  readPairedBinaryFromNote,
  updateNote,
  upsertSection,
} from "./writer";
import type { IdeaStatus } from "@carnet/shared";

export interface EnrichResult {
  markdown: string;
  model: string;
}

/**
 * Apply a per-mode prompt override. Returns the pair unchanged when the
 * override is missing, undefined, or whitespace-only — so callers can
 * always invoke this safely without special-casing the "no override" path.
 *
 * The user message is never replaced — only the system. This preserves
 * the INJECTION_GUARD-protected delimiter shape that wraps user content,
 * even when the user has fully rewritten the system instructions.
 */
export function withSystemOverride(
  pair: PromptPair,
  override: string | undefined,
): PromptPair {
  const trimmed = override?.trim() ?? "";
  if (!trimmed) return pair;
  return { system: trimmed, user: pair.user };
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

/** Hard cap on image payload sent to a vision model. Vision providers reject
 * >10 MB payloads and the in-memory peak on a phone (base64 inflates by 33%,
 * then JSON.stringify duplicates it for the request body) can OOM the app.
 * Both share-target and in-app photo capture enforce this ceiling.
 *
 * Note: `quality: 0.6` on expo-camera caps JPEG compression but NOT
 * resolution — a 50 MP sensor can still produce >8 MB at q=0.6. So callers
 * MUST gate on `assertBase64UnderLimit` rather than trusting quality alone. */
export const MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024;

/** Hard cap for the audio payload sent to Whisper. OpenAI's hosted Whisper
 * rejects >25 MB; LiteLLM-style proxies enforce the same. Pre-check before
 * the multipart upload so users see a friendly error instead of a confusing
 * 413 from the provider. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/** Throw a user-friendly OmniRouteError if `base64` decodes to more than
 * `MAX_SHARED_IMAGE_BYTES`. Avoids materialising the binary — base64 length
 * × 0.75 is exact enough (off-by-≤2 bytes from padding `=`).
 *
 * Uses HTTP 413 (Payload Too Large) so `isPermanentError` correctly
 * classifies this as non-retryable — the image will never magically shrink. */
export function assertBase64UnderLimit(base64: string): void {
  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes > MAX_SHARED_IMAGE_BYTES) {
    const mb = Math.round(approxBytes / 1024 / 1024);
    const capMb = Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024);
    throw new OmniRouteError(
      `Image is ${mb} MB — carnet caps at ${capMb} MB. Downscale or crop before sending.`,
      413,
    );
  }
}

/** Strip any "Bearer ..." substring from an error message so the API key
 * never lands in stored error logs or on-screen toasts. Also strip the
 * Authorization header form just in case. */
function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/**
 * Reject non-HTTPS OmniRoute URLs to prevent the API key from being sent
 * over cleartext. Localhost / loopback / RFC1918 (10.x) are allowed for
 * dev — the host-on-LAN dev loop relies on plain HTTP. All other http://
 * URLs throw.
 *
 * Extracted from three call sites (executeChat, listModels, transcribeAudio).
 */
function assertHttpsOrLocal(trimmed: string): void {
  if (/^https:\/\//i.test(trimmed)) return;
  if (/^http:\/\/(localhost|127\.0\.0\.1|10\.)/i.test(trimmed)) return;
  throw new OmniRouteError(
    "OmniRoute URL must use https:// to protect the API key",
    0,
  );
}

/**
 * Build a sanitized HTTP-error detail string from a failing Response. Reads
 * the body as JSON and appends `error.message` if present; swallows parse
 * failures because the status alone is enough signal in that case.
 *
 * Extracted from three call sites (executeChat, listModels, transcribeAudio).
 */
async function parseErrorBody(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`;
  try {
    const errBody = (await response.json()) as OpenAIResponse;
    if (errBody.error?.message) {
      detail += `: ${sanitizeErrorMessage(errBody.error.message)}`;
    }
  } catch {
    // ignore parse failure — status alone is enough
  }
  return detail;
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
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

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
    throw new OmniRouteError(
      `OmniRoute error — ${await parseErrorBody(response)}`,
      response.status,
    );
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

async function getTranscriptionModel(): Promise<string> {
  const settings = await getSettings();
  return settings.omniRouteTranscriptionModel.trim() || "whisper-1";
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
  assertHttpsOrLocal(trimmed);

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
    throw new OmniRouteError(
      `OmniRoute error — ${await parseErrorBody(response)}`,
      response.status,
    );
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
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(buildIdeaPrompt(text), overrides.idea);
  return chatCompletion(baseUrl, apiKey, model, pair);
}

/** Enrich a journal voice transcript (plus optional notes) into a journal entry. */
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
  return chatCompletion(baseUrl, apiKey, model, pair);
}

/** Enrich a business card OCR result + context into a contact note. */
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
  return chatCompletion(baseUrl, apiKey, model, pair);
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
  // Allowlist mime — defends against pathological values being interpolated
  // into a data: URL. Falls back to image/jpeg for the common case where
  // the share intent didn't carry a precise type.
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
  // Multimodal user content can't go through withSystemOverride (which is
  // PromptPair-shaped), so the splice happens inline. Same null-safe rule:
  // empty/whitespace override → default.
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
  return executeChat(baseUrl, apiKey, model, messages);
}

/**
 * Text-only enrichment for a URL or raw text shared into carnet. When
 * a URL is present, we fetch the page first (best-effort, in parallel
 * with the settings reads) and thread the resulting title /
 * description / site name through the prompt. On any fetch failure
 * the preview is null and the prompt falls back to URL-string-only
 * reasoning — never blocks the enrichment call.
 *
 * Optional `onPreviewSettled` callback fires once the preview promise
 * resolves (with success or null), enabling a UI sub-state transition
 * from "Fetching link preview…" to "Enriching with OmniRoute…" so the
 * spinner gives honest progress on slow networks.
 */
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
    // Fire-and-forget — never let a callback throw bubble up here.
    previewPromise.finally(() => {
      try {
        input.onPreviewSettled?.();
      } catch {
        // swallow — caller's UI state is best-effort
      }
    });
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
  return chatCompletion(baseUrl, apiKey, model, pair);
}

/**
 * Transcribe an audio file via OmniRoute's OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (Whisper). POSTs the bytes as
 * multipart/form-data with `file` + `model` fields. Returns the recognized
 * text and the model that was used.
 *
 * Same HTTPS guard + sanitization + abort timeout as the chat path — the
 * guard is duplicated rather than extracted because two consumers don't
 * yet justify a shared helper, and the chat-completions code path has
 * its own JSON body shape it doesn't want to share.
 *
 * Pre-checks the 25 MB Whisper cap from the base64 length so an oversized
 * recording fails locally instead of after a slow upload that ends in 413.
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
    throw new OmniRouteError(
      `Audio is ${mb} MB — Whisper caps at ${capMb} MB. Split or compress before transcribing.`,
      413,
    );
  }

  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getTranscriptionModel(),
  ]);

  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  // RN's fetch handles data: URIs; round-tripping through Blob is the
  // canonical way to attach binary bytes to a multipart FormData without
  // requiring filesystem access. base64 → Blob is sync-fast in practice.
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append("file", blob, input.filename);
  form.append("model", model);
  form.append("response_format", "json");

  const url = `${trimmed}/v1/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    // DO NOT set Content-Type — fetch must add the multipart boundary itself.
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: form as unknown as BodyInit,
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
    throw new OmniRouteError(
      `OmniRoute transcription error — ${await parseErrorBody(response)}`,
      response.status,
    );
  }

  // Wrap success-path JSON parse — some proxies (LiteLLM misconfigs) return
  // text/plain on a 200, which would otherwise leak a raw SyntaxError that
  // bypasses OmniRouteError classification (isPermanentError would miss it).
  let json: { text?: string };
  try {
    json = (await response.json()) as { text?: string };
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new OmniRouteError(
      `OmniRoute returned non-JSON transcription body — ${sanitizeErrorMessage(raw)}`,
      response.status,
    );
  }
  const text = json.text?.trim() ?? "";
  if (!text) {
    // Empty transcript usually means Whisper detected silence. Don't write
    // an empty `## Transcript` section — surface as an error so the user
    // knows nothing was recognized.
    throw new OmniRouteError(
      "Whisper returned an empty transcript",
      response.status,
    );
  }
  return { text, model };
}

/**
 * Optional post-save hook for audio captures. When the user has flipped
 * `autoTranscribeOnSave` on in Settings, this reads the paired audio file
 * off disk, runs Whisper, and idempotently inserts a `## Transcript`
 * section back into the note via upsertSection.
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
