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

/** OpenAI-compatible content part for multimodal messages. `input_audio`
 * is the OpenAI shape that LiteLLM bridges to Gemini's audio modality and
 * to OpenAI's own gpt-4o-audio-preview. `format` is the file extension
 * minus the dot (e.g. "m4a", "mp3", "wav"). */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

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
export class OmniRouteError extends HttpError {
  constructor(
    message: string,
    status: number,
    opts?: { notConfigured?: boolean },
  ) {
    super(message, status, opts);
    this.name = "OmniRouteError";
  }
}

/** True for HTTP statuses that indicate a permanent failure — caller should
 * NOT enqueue these for automatic retry. */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof OmniRouteError)) return false;
  return err.status >= 400 && err.status < 500;
}

/** True when the request failed because OmniRoute is not configured (blank
 * URL). Distinct from a transient network status-0 error: retrying/queuing is
 * pointless until the user sets a URL, so the caller should surface this. */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof OmniRouteError && err.notConfigured;
}

// Hard ceiling on any single OmniRoute request. Kept short because an
// unreachable host (e.g. OmniRoute on a tailnet with Tailscale down) must
// fail fast so the caller's offline-queue path fires instead of spinning.
// Trade-off: a genuine generation that runs longer than this is cut off.
const FETCH_TIMEOUT_MS = 20_000;

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

/**
 * Reject non-HTTPS OmniRoute URLs to prevent the API key from being sent
 * over cleartext. HTTPS is always allowed; plain http:// is allowed only for
 * the local / LAN dev + self-hosted loop (loopback, 10.x, 192.168.x) via
 * exact-host parsing in {@link isCredentialSafeUrl}. All other http:// URLs
 * throw.
 *
 * Extracted from three call sites (executeChat, listModels, transcribeAudio).
 */
function assertHttpsOrLocal(trimmed: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
  throw new OmniRouteError(
    "OmniRoute URL must use https:// to protect the API key",
    0,
  );
}

/** Status-0 timeout error for {@link withTimeout} — the user-facing message
 * (with its Tailscale hint) is this client's own; the timeout MECHANISM is
 * shared (lib/httpClient.ts), so hardening fixes reach both clients. */
function omniRouteTimeoutError(ms: number): OmniRouteError {
  return new OmniRouteError(
    `OmniRoute unreachable — timed out after ${Math.round(ms / 1000)}s. Check your connection (Tailscale?).`,
    0,
  );
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
  noteType: NoteType,
): Promise<EnrichResult> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await withTimeout(FETCH_TIMEOUT_MS, omniRouteTimeoutError, async (signal) => {
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
      // Timeout already arrives as a shaped OmniRouteError — don't double-wrap.
      if (e instanceof OmniRouteError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      const msg = sanitizeErrorMessage(raw);
      throw new OmniRouteError(`OmniRoute network error — ${msg}`, 0);
    }

    // Body reads run INSIDE the timeout — a never-closing body hangs here
    // just like a stuck connect would.
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

    // Security gate (B3): neutralize any executable content the model emitted
    // (Dataview/Templater/raw HTML/javascript: links) and canonicalize the
    // frontmatter BEFORE the markdown reaches any caller or the vault.
    // Neutralization is unconditional; when frontmatter normalization fails
    // (malformed / missing required keys) we still return the neutralized —
    // and therefore inert — markdown rather than a note that could execute.
    const stripped = stripCodeFences(content);
    const markdown = sanitizeAndNormalize(stripped, noteType) ?? sanitizeMarkdown(stripped);
    const modelUsed = json.model ?? model;
    return { markdown, model: modelUsed };
  });
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
  noteType: NoteType,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages, noteType);
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
      { notConfigured: true },
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
 * The vision-capable model for image-bearing enrichment. Held separately from
 * getModel() (the chat/text model) so a text-only chat model can never
 * silently eat image parts. Unlike getModel(), this does NOT fall back to a
 * hard-coded default: a blank vision model surfaces as a not-configured
 * OmniRouteError so callers route it through the same isNotConfiguredError
 * degraded path as a blank URL — the user fixes Settings rather than the app
 * misrouting an image to whatever the fallback happens to be.
 */
async function getVisionModel(): Promise<string> {
  const settings = await getSettings();
  const model = settings.omniRouteVisionModel.trim();
  if (!model) {
    throw new OmniRouteError(
      "Vision model not configured — set it in Settings",
      0,
      { notConfigured: true },
    );
  }
  return model;
}

// (getTranscriptionModel removed — transcribeAudio is on-device now and
// doesn't route through OmniRoute.)

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

  return await withTimeout(FETCH_TIMEOUT_MS, omniRouteTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof OmniRouteError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new OmniRouteError(
        `OmniRoute network error — ${sanitizeErrorMessage(raw)}`,
        0,
      );
    }

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
  });
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
  return chatCompletion(baseUrl, apiKey, model, pair, "idea");
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
  return chatCompletion(baseUrl, apiKey, model, pair, "journal");
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
  return chatCompletion(baseUrl, apiKey, model, pair, "person");
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
  // Vision path: route to the dedicated vision model, NOT getModel() (the
  // chat/text model). A text-only chat model would silently drop the image
  // part and return a confidently-wrong enrichment with no banner.
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getVisionModel(),
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
  return executeChat(baseUrl, apiKey, model, messages, "shared");
}

/**
 * Fixed transcription instruction for business-card OCR. Verified on-device
 * against the (now-retired) dedicated `/v1/ocr` Mistral endpoint — do NOT
 * reword: the phrasing is what makes the VLM emit a faithful, one-field-per-line
 * transcription instead of a chatty summary. The extracted text feeds
 * `enrichPerson` (which builds the contact note), so it must stay raw and
 * unnormalized here — enrichment applies its own sanitize/normalize pass.
 */
const OCR_CARD_PROMPT =
  "Transcribe ALL text on this business card exactly as printed. Preserve every field: name, title, company, phone numbers, email addresses, websites, physical address, and any other text. Output plain text, one field per line. Do not invent, omit, or normalize anything.";

/**
 * Transcribe a business-card image via the vision model, replacing the bespoke
 * `POST /v1/ocr` path (retired 2026-07-12 — see Stage 2 B2). Uses the same
 * settings plumbing and mime allowlist as {@link enrichSharedImage}, but sends
 * a single user turn (no system message) with a fixed transcription prompt and
 * `temperature: 0` for deterministic, faithful output.
 *
 * Unlike {@link executeChat}, this returns the RAW model content (trimmed) with
 * NO markdown sanitization or frontmatter normalization: the output is not a
 * vault note, it is contact text handed to `enrichPerson`, whose enriched
 * result is the thing that gets sanitized before write. Throws a
 * "no OCR text" OmniRouteError on empty content so the caller's existing
 * failure UX (and the person degraded-save path downstream) behaves identically
 * to the old `/v1/ocr` client.
 */
export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  // Same allowlist as enrichSharedImage — defends against a pathological mime
  // being interpolated into the data: URL; falls back to image/jpeg.
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const [baseUrl, apiKey, model] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getVisionModel(),
  ]);
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
  // temperature: 0 — transcription must be deterministic, not creative. Built
  // into the body directly (no executeChat plumbing) since this path returns
  // raw text rather than a sanitized note.
  const body = JSON.stringify({ model, messages, stream: false, temperature: 0 });

  return await withTimeout(FETCH_TIMEOUT_MS, omniRouteTimeoutError, async (signal) => {
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
      if (e instanceof OmniRouteError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new OmniRouteError(
        `OmniRoute network error — ${sanitizeErrorMessage(raw)}`,
        0,
      );
    }

    if (!response.ok) {
      throw new OmniRouteError(
        `OmniRoute error — ${await parseErrorBody(response)}`,
        response.status,
      );
    }

    const json = (await response.json()) as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new OmniRouteError(
        "OmniRoute response contained no OCR text",
        response.status,
      );
    }
    return { text };
  });
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
  return chatCompletion(baseUrl, apiKey, model, pair, "shared");
}

/**
 * Transcribe an audio file using the on-device speech recognizer
 * (expo-speech-recognition → Google Soda on Android). Lives under the
 * omniroute.ts API surface for caller compatibility even though it
 * doesn't actually hit OmniRoute — the prior chat-completion / Whisper
 * paths were swapped out after Gemini multimodal kept refusing
 * verbatim transcription via content-policy and the user's proxy
 * didn't expose a Whisper endpoint.
 *
 * On-device wins:
 *   - Free, no per-capture API cost
 *   - Private — audio never leaves the device
 *   - Works without OmniRoute being configured / reachable
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
    throw new OmniRouteError(
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
    "idea",
  );
}
