/**
 * Merged OpenAI-compatible LLM client for carnet (Stage: LLM provider list,
 * Phase 1 — see docs/superpowers/specs/2026-07-31-llm-provider-list-design.md).
 *
 * Formerly two near-duplicate clients — omniroute.ts and localLlm.ts — that
 * both POSTed to `${baseUrl}/v1/chat/completions`, both GET
 * `${baseUrl}/v1/models`, and differed only in which settings fields fed
 * them and in the vision path. This module is the merge: ONE client,
 * parameterized by a {@link ProviderConfig} the caller supplies.
 *
 * This module reads NO settings itself — that is the whole point of the
 * seam. `dispatcher.ts` resolves a `ProviderConfig` from today's settings
 * fields (replicating each backend's exact defaulting behavior: OmniRoute's
 * blank-model fallback to a hard-coded default and blank-URL not-configured
 * error; the local backend's blank-URL fallback to the loopback default and
 * blank-model not-configured error) and passes it into every call here.
 *
 * Each method corresponds to one capture mode:
 *   enrichIdea    — raw thought → structured Obsidian markdown
 *   enrichJournal — voice transcript → journal entry
 *   enrichPerson  — OCR business card + context → contact note
 *   promoteIdea   — rewrite an existing idea at a higher maturity status
 */

import { sanitizeAndNormalize, sanitizeMarkdown, type NoteType } from "./enrichSanitize";
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
import type { IdeaStatus } from "@carnet/shared";

/** One configured OpenAI-compatible endpoint. The caller (dispatcher.ts)
 * resolves this from settings — this module never reads settings itself. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Vision-capable model id; "" means this provider serves no vision
   * calls, which surfaces as a not-configured error from the vision-path
   * functions (enrichSharedImage, ocrCardViaVision). */
  visionModel: string;
  /** Human-readable provider name, threaded into every error message this
   * client throws so Phase 1 stays byte-identical to the pre-merge
   * omniroute.ts/localLlm.ts wording (a reviewer must be able to diff
   * enrichment BEHAVIOR against this commit alone — that includes the exact
   * text a user sees in an error banner). Pre-stages Phase 2, where every
   * provider list entry has a label anyway. */
  label: string;
}

/** Default base URL for a loopback/LAN deployment (e.g. Relais) when the
 * caller's URL field is blank — a zero-setup disconnected flow, not a
 * not-configured error. Exported so dispatcher.ts can replicate it when
 * resolving a ProviderConfig, and so healthCheck can apply the same default
 * to a caller-supplied raw URL. */
export const DEFAULT_LOCAL_LLM_URL = "http://127.0.0.1:8080";

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
 * Error thrown by this client. Carries the HTTP status so callers classify
 * between transient (network / 5xx — safe to queue and retry) and permanent
 * (4xx — auth / bad model / malformed request — surface to user, do NOT
 * retry blindly). Status `0` means a network-level failure (DNS, TLS,
 * connection refused, abort) — or a missing configuration, see
 * `notConfigured`.
 *
 * Named generically (not per-backend) because this class now serves every
 * provider — the generalization that used to live only in isPermanentError/
 * isNotConfiguredError (classifying via the shared HttpError base rather
 * than a backend-specific subclass) is now reflected in the class itself.
 */
export class LlmClientError extends HttpError {
  constructor(
    message: string,
    status: number,
    opts?: { notConfigured?: boolean },
  ) {
    super(message, status, opts);
    this.name = "LlmClientError";
  }
}

/** True for HTTP statuses that indicate a permanent failure — caller should
 * NOT enqueue these for automatic retry. Classifies via the shared HttpError
 * base (not LlmClientError specifically) so any HttpError subclass is
 * classified correctly without callers needing per-backend predicates. */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.status >= 400 && err.status < 500;
}

/** True when the request failed because the provider is not configured
 * (blank URL or blank model). Distinct from a transient network status-0
 * error: retrying/queuing is pointless until the user fixes Settings, so
 * the caller should surface this instead. */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof HttpError && err.notConfigured;
}

// Hard ceiling on any single request. Kept short because an unreachable host
// (e.g. a gateway on a tailnet with Tailscale down) must fail fast so the
// caller's offline-queue path fires instead of spinning.
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

/** Throw a user-friendly LlmClientError if `base64` decodes to more than
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
    throw new LlmClientError(
      `Image is ${mb} MB — carnet caps at ${capMb} MB. Downscale or crop before sending.`,
      413,
    );
  }
}

/**
 * Reject non-HTTPS provider URLs to prevent the API key from being sent
 * over cleartext. HTTPS is always allowed; plain http:// is allowed only for
 * the local / LAN dev + self-hosted loop (loopback, 10.x, 192.168.x) via
 * exact-host parsing in {@link isCredentialSafeUrl}. All other http:// URLs
 * throw.
 *
 * Both pre-merge clients shared this exact guard (`isCredentialSafeUrl`) —
 * OmniRoute's original message just never SAID the loopback/LAN exemption
 * existed ("...must use https:// to protect the API key"), which was
 * misleading about its own behavior. Both providers now state the true
 * guard; this is not a security change (verified: same predicate, same
 * outcomes either way), only a corrected message.
 */
function assertHttpsOrLocal(trimmed: string, label: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
  throw new LlmClientError(
    `${label} URL must use https:// (or be a loopback/LAN address) to protect the API key`,
    0,
  );
}

/** Status-0 timeout error for {@link withTimeout} — the timeout MECHANISM is
 * shared (lib/httpClient.ts), so hardening fixes reach every caller.
 *
 * OmniRoute's original timeout message ended with a Tailscale connectivity
 * hint (it's usually reached over a tailnet); the local backend's did not
 * (it's a loopback/LAN server, not tailnet-routed) — preserved per provider
 * rather than merged into one wording. */
function timeoutError(label: string, ms: number): LlmClientError {
  const tailscaleHint =
    label === "OmniRoute" ? " Check your connection (Tailscale?)." : "";
  return new LlmClientError(
    `${label} unreachable — timed out after ${Math.round(ms / 1000)}s.${tailscaleHint}`,
    0,
  );
}

/** Throw not-configured when a resolved base URL is blank. `config.baseUrl`
 * is pre-resolved by the caller — the local backend's blank URL is defaulted
 * to the loopback address by dispatcher.ts before the config is built, so
 * this only ever actually fires for a provider (like OmniRoute) whose blank
 * URL has no sensible default. */
function assertUrlConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LlmClientError(`${label} URL not configured — set it in Settings`, 0, {
      notConfigured: true,
    });
  }
  return trimmed;
}

/** Throw not-configured when a resolved text/chat model is blank. Mirrors
 * the local backend's original getModel() message exactly ("Local LLM model
 * not configured..."). OmniRoute's model always has a hard-coded default
 * substituted by dispatcher.ts before the config is built, so this never
 * actually fires for OmniRoute. */
function assertModelConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LlmClientError(`${label} model not configured — set it in Settings`, 0, {
      notConfigured: true,
    });
  }
  return trimmed;
}

/** Throw not-configured when a resolved vision model is blank.
 *
 * OmniRoute originally had a DEDICATED getVisionModel() with its own
 * unbranded message ("Vision model not configured — set it in Settings"),
 * distinct from its getModel() text-model message. The local backend has no
 * separate vision concept — it reuses getModel() (and therefore the same
 * BRANDED "Local LLM model not configured..." message) for both text and
 * vision, because `config.visionModel` IS `config.model` for that backend.
 * Preserved exactly per origin rather than collapsed into one string. */
function assertVisionModelConfigured(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    const message =
      label === "OmniRoute"
        ? "Vision model not configured — set it in Settings"
        : `${label} model not configured — set it in Settings`;
    throw new LlmClientError(message, 0, { notConfigured: true });
  }
  return trimmed;
}

/**
 * Low-level POST to /v1/chat/completions. Sends arbitrary OpenAI-compatible
 * messages — text or multimodal. Used both for the text-only modes
 * (idea/journal/person) and for vision-enabled share-target enrichment.
 *
 * stream: false is REQUIRED. Some OpenAI-compatible gateways (LiteLLM-style
 * proxies) default to text/event-stream even when stream is omitted. RN's
 * fetch then hangs on `await response.json()` because the SSE body never
 * closes into a parseable JSON document.
 */
async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  noteType: NoteType,
  label: string,
): Promise<EnrichResult> {
  const trimmed = assertUrlConfigured(baseUrl, label);
  const trimmedUrl = trimmed.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmedUrl, label);

  const url = `${trimmedUrl}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await withTimeout(
    FETCH_TIMEOUT_MS,
    (ms) => timeoutError(label, ms),
    async (signal) => {
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
        // Timeout already arrives as a shaped LlmClientError — don't double-wrap.
        if (e instanceof LlmClientError) throw e;
        const raw = e instanceof Error ? e.message : String(e);
        const msg = sanitizeErrorMessage(raw);
        throw new LlmClientError(`${label} network error — ${msg}`, 0);
      }

      // Body reads run INSIDE the timeout — a never-closing body hangs here
      // just like a stuck connect would.
      if (!response.ok) {
        throw new LlmClientError(
          `${label} error — ${await parseErrorBody(response)}`,
          response.status,
        );
      }

      const json = (await response.json()) as OpenAIResponse;
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim().length) {
        throw new LlmClientError(
          `${label} returned an empty or malformed response`,
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
    },
  );
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
  label: string,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages, noteType, label);
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

/**
 * Fetch the available model catalog from `${baseUrl}/v1/models`. Returns
 * the sorted list of model IDs. Same auth + HTTPS rules as chatCompletion.
 *
 * This is the network primitive behind the Settings screen's "Browse
 * models" picker — so the user can see what's actually available on their
 * configured provider instead of guessing a model name.
 */
export async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  // No ProviderConfig (and therefore no label) at this call site — the model
  // browser calls this directly with a raw base URL/key pair. dispatcher.ts
  // used to route this through whichever backend module was active
  // (llmBackend); it now always calls this one merged listModels, which is
  // a narrowing when llmBackend === "local" (the local backend used to have
  // its own blank-URL-defaults-to-loopback behavior here, and its own "Local
  // LLM ..." message branding). Left as-is (see dispatcher.ts's comment at
  // its listModels re-export) — the only real caller (SettingsScreen) always
  // passes an explicit URL, so the blank-default path was already dead for
  // this call, and the message branding was never asserted by any test.
  assertHttpsOrLocal(trimmed, "LLM provider");

  const url = `${trimmed}/v1/models`;

  return await withTimeout(
    FETCH_TIMEOUT_MS,
    (ms) => timeoutError("LLM provider", ms),
    async (signal) => {
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
        if (e instanceof LlmClientError) throw e;
        const raw = e instanceof Error ? e.message : String(e);
        throw new LlmClientError(
          `LLM provider network error — ${sanitizeErrorMessage(raw)}`,
          0,
        );
      }

      if (!response.ok) {
        throw new LlmClientError(
          `LLM provider error — ${await parseErrorBody(response)}`,
          response.status,
        );
      }

      const json = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return [...new Set(ids)].sort();
    },
  );
}

/** Reachability check for the Settings screen's "Test Connection" button.
 * Never throws — returns false on any failure (timeout, network error,
 * non-2xx). Deliberately does NOT go through assertHttpsOrLocal's
 * throw-on-unsafe-URL path — a connectivity CHECK should report false for
 * an unsafe URL, not throw and crash the button handler. Blank URL defaults
 * to the loopback address, matching a zero-setup local deployment. */
/** Why a connectivity check failed.
 *
 * These are distinguished because a platform cleartext block and a stopped
 * server are identical from the response's point of view — both are a rejected
 * fetch — but the user's next action is completely different. Collapsing them
 * into a boolean told users to "check that the server is running" when Android
 * was refusing the connection and the server was fine (verified on a release
 * build, 2026-08-01: cleartext to loopback is permitted, cleartext to a LAN
 * address is not). */
export type HealthResult =
  | "ok"
  | "unreachable"
  | "blocked-cleartext"
  | "unsafe-url";

export async function healthCheck(baseUrl: string): Promise<HealthResult> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  if (!isCredentialSafeUrl(trimmed)) return "unsafe-url";
  try {
    return await withTimeout(
      FETCH_TIMEOUT_MS,
      (ms) => timeoutError("LLM provider", ms),
      async (signal) => {
        const response = await fetch(`${trimmed}/health`, { method: "GET", signal });
        return response.ok ? "ok" : "unreachable";
      },
    );
  } catch (e: unknown) {
    // React Native surfaces the platform block as a plain TypeError; the
    // message text is the only signal available, so match on it rather than
    // pretending there is a typed error to catch.
    const message = e instanceof Error ? e.message : String(e);
    return /cleartext/i.test(message) ? "blocked-cleartext" : "unreachable";
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enrich a raw idea text into structured Obsidian markdown. */
export async function enrichIdea(
  text: string,
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  const pair = withSystemOverride(buildIdeaPrompt(text), override);
  return chatCompletion(config.baseUrl, config.apiKey, model, pair, "idea", config.label);
}

/** Enrich a journal voice transcript (plus optional notes) into a journal entry. */
export async function enrichJournal(
  input: { transcript: string; notes: string },
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  const pair = withSystemOverride(
    buildJournalPrompt(input.transcript, input.notes),
    override,
  );
  return chatCompletion(config.baseUrl, config.apiKey, model, pair, "journal", config.label);
}

/** Enrich a business card OCR result + context into a contact note. */
export async function enrichPerson(
  input: { ocrResult: string; context: string },
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  const pair = withSystemOverride(
    buildPersonPrompt(input.ocrResult, input.context),
    override,
  );
  return chatCompletion(config.baseUrl, config.apiKey, model, pair, "person", config.label);
}

/**
 * Vision-enabled enrichment for an image shared into carnet. Sends the
 * image inline as a base64 data URL alongside a curator-style prompt that
 * asks the model to give the note a real title, describe what's in the
 * image, and weave in the user's context. Requires a vision-capable model —
 * routes to `config.visionModel`, NOT `config.model` (the chat/text model).
 * A text-only chat model would silently drop the image part and return a
 * confidently-wrong enrichment with no banner.
 */
export async function enrichSharedImage(
  input: { base64: string; mimeType: string; context: string },
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  // Allowlist mime — defends against pathological values being interpolated
  // into a data: URL. Falls back to image/jpeg for the common case where
  // the share intent didn't carry a precise type.
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const model = assertVisionModelConfigured(config.visionModel, config.label);
  const { system: defaultSystem, userText } = buildSharedImagePrompt(input.context);
  // Multimodal user content can't go through withSystemOverride (which is
  // PromptPair-shaped), so the splice happens inline. Same null-safe rule:
  // empty/whitespace override → default.
  const systemOverride = override?.trim() ?? "";
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
  return executeChat(config.baseUrl, config.apiKey, model, messages, "shared", config.label);
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
 * mime allowlist as {@link enrichSharedImage}, but sends a single user turn
 * (no system message) with a fixed transcription prompt and `temperature: 0`
 * for deterministic, faithful output.
 *
 * Unlike {@link executeChat}, this returns the RAW model content (trimmed) with
 * NO markdown sanitization or frontmatter normalization: the output is not a
 * vault note, it is contact text handed to `enrichPerson`, whose enriched
 * result is the thing that gets sanitized before write. Throws a
 * "no OCR text" LlmClientError on empty content so the caller's existing
 * failure UX (and the person degraded-save path downstream) behaves identically
 * to the old `/v1/ocr` client.
 */
export async function ocrCardViaVision(
  input: { base64: string; mimeType: string },
  config: ProviderConfig,
): Promise<{ text: string }> {
  // Same allowlist as enrichSharedImage — defends against a pathological mime
  // being interpolated into the data: URL; falls back to image/jpeg.
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const model = assertVisionModelConfigured(config.visionModel, config.label);
  const trimmed = assertUrlConfigured(config.baseUrl, config.label);
  const trimmedUrl = trimmed.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmedUrl, config.label);

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
  const url = `${trimmedUrl}/v1/chat/completions`;
  // temperature: 0 — transcription must be deterministic, not creative. Built
  // into the body directly (no executeChat plumbing) since this path returns
  // raw text rather than a sanitized note.
  const body = JSON.stringify({ model, messages, stream: false, temperature: 0 });

  return await withTimeout(
    FETCH_TIMEOUT_MS,
    (ms) => timeoutError(config.label, ms),
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body,
          signal,
        });
      } catch (e: unknown) {
        if (e instanceof LlmClientError) throw e;
        const raw = e instanceof Error ? e.message : String(e);
        throw new LlmClientError(
          `${config.label} network error — ${sanitizeErrorMessage(raw)}`,
          0,
        );
      }

      if (!response.ok) {
        throw new LlmClientError(
          `${config.label} error — ${await parseErrorBody(response)}`,
          response.status,
        );
      }

      const json = (await response.json()) as OpenAIResponse;
      const content = json.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content.trim() : "";
      if (!text) {
        throw new LlmClientError(
          `${config.label} response contained no OCR text`,
          response.status,
        );
      }
      return { text };
    },
  );
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
 * from "Fetching link preview…" to "Enriching…" so the spinner gives
 * honest progress on slow networks.
 */
export async function enrichSharedLink(
  input: {
    url: string;
    text: string;
    context: string;
    onPreviewSettled?: () => void;
  },
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  const previewPromise: Promise<UrlPreview | null> = input.url
    ? fetchUrlPreview(input.url)
    : Promise.resolve(null);
  if (input.onPreviewSettled) {
    // Fire-and-forget settle observer. Deliberately .then(fn, fn) rather than
    // .finally(fn): .finally RE-REJECTS through its returned promise, so a
    // preview failure would surface as an unhandled rejection from this
    // observer chain even though the main await below handles it.
    const fireSettled = (): void => {
      try {
        input.onPreviewSettled?.();
      } catch {
        // swallow — caller's UI state is best-effort
      }
    };
    void previewPromise.then(fireSettled, fireSettled);
  }
  // Config checks BEFORE awaiting the preview: a blank URL/model must reject
  // immediately (matching the pre-merge Promise.all shape, where the config
  // getters and the preview fetch raced together). Awaiting the preview
  // first would leave a not-configured user staring at a spinner for up to
  // fetchUrlPreview's own timeout (8s) before finding out nothing was ever
  // going to be sent.
  const model = assertModelConfigured(config.model, config.label);
  assertUrlConfigured(config.baseUrl, config.label);
  const preview = await previewPromise;
  const pair = withSystemOverride(
    buildSharedLinkPrompt(input.url, input.text, input.context, preview),
    override,
  );
  return chatCompletion(config.baseUrl, config.apiKey, model, pair, "shared", config.label);
}

/**
 * Rewrite an existing idea note to reflect a new status level.
 * Returns the updated markdown and the model used.
 */
export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
  config: ProviderConfig,
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  return chatCompletion(
    config.baseUrl,
    config.apiKey,
    model,
    buildPromoteIdeaPrompt(currentMarkdown, target),
    "idea",
    config.label,
  );
}
