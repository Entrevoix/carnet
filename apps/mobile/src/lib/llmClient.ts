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
 *
 * This module owns the public API surface: provider config, the
 * enrich-family/promoteIdea/enhanceProse capture-mode functions, model
 * listing, and the connectivity health check. Logic that sits beside it was
 * extracted into focused siblings and is RE-EXPORTED from here, so the
 * `./llmClient` import path stays valid for every existing caller:
 *   ./llmErrors — LlmClientError and its status-classification predicates
 *   ./llmGuards — config-precondition asserts (blank URL/model/vision-model,
 *                 image size, HTTPS-or-local transport)
 *   ./llmHttp   — the OpenAI wire types and the executeChat/chatCompletion
 *                 fetch primitives
 *
 * `assertVisionReady` in ./llmGuards takes a structural
 * `{ visionModel, baseUrl, label }` shape rather than importing
 * `ProviderConfig` from here, to avoid an import cycle (this module imports
 * ./llmGuards) — `ProviderConfig` satisfies that shape structurally, so
 * callers are unaffected.
 */

import {
  buildEnhanceProsePrompt,
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
  type PromptPair,
} from "./prompts";
import { isCredentialSafeUrl } from "./netAllowlist";
import { parseErrorBody, sanitizeErrorMessage, withTimeout } from "./httpClient";
import { fetchUrlPreview, type UrlPreview } from "./urlpreview";
import type { IdeaStatus } from "@carnet/shared";
import { LlmClientError, timeoutError } from "./llmErrors";
import {
  assertHttpsOrLocal,
  assertModelConfigured,
  assertUrlConfigured,
  assertVisionModelConfigured,
  assertVisionReady,
} from "./llmGuards";
import { chatCompletion, executeChat, FETCH_TIMEOUT_MS, ENHANCE_TIMEOUT_MS, type OpenAIMessage, type OpenAIResponse } from "./llmHttp";

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
  | "unauthorized"
  | "blocked-cleartext"
  | "unsafe-url";

/**
 * Probe the provider the way the app actually talks to it: `GET /v1/models`
 * with the Bearer key, the same request `listModels` makes.
 *
 * It used to GET `/health` with no auth. That endpoint came from the local-LLM
 * (Relais) client and survived the #120 merge into this unified client, at
 * which point it started being applied to EVERY provider — including
 * OpenAI-compatible gateways like OmniRoute, which serve `/v1/*` and have no
 * `/health` at all. The result was "Unreachable" on a provider whose real
 * calls were succeeding. Probing an endpoint nothing else uses cannot tell the
 * user whether the thing they care about works; probing `/v1/models` can, and
 * it validates the API key besides.
 */
export async function healthCheck(
  baseUrl: string,
  apiKey: string,
): Promise<HealthResult> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  if (!isCredentialSafeUrl(trimmed)) return "unsafe-url";
  try {
    return await withTimeout(
      FETCH_TIMEOUT_MS,
      (ms) => timeoutError("LLM provider", ms),
      async (signal) => {
        const response = await fetch(`${trimmed}/v1/models`, {
          method: "GET",
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          signal,
        });
        if (response.ok) return "ok";
        // A rejected credential is not an unreachable host. Saying
        // "check that the server is running" when the server answered
        // sends the user to debug the wrong thing.
        if (response.status === 401 || response.status === 403) {
          return "unauthorized";
        }
        return "unreachable";
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
 * Unlike {@link executeChat}, this returns the RAW model content unchanged with
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
  const { model, url: trimmedUrl } = assertVisionReady(config);

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
      const text = typeof content === "string" ? content : "";
      if (!text.trim()) {
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

/**
 * Rewrite a note's prose body with a (typically stronger) model.
 *
 * Input and output are BODY TEXT ONLY — the caller (`lib/enhanceProse.ts`)
 * owns splitting off frontmatter and the `# Title` heading and re-attaching
 * them afterwards, so neither is ever exposed to the model.
 *
 * The `"journal"` NoteType is inert for this call, and deliberately so:
 * executeChat feeds it to sanitizeAndNormalize, whose normalizeFrontmatter
 * bails at its first check (`if (!header) return null`) because prose-only
 * output has no frontmatter block. The per-type REQUIRED_KEYS/CANONICAL_ORDER
 * tables are therefore never consulted and no frontmatter can be fabricated
 * onto the body — it falls through to plain sanitizeMarkdown, which still
 * neutralizes Templater/HTML/dataviewjs. Any NoteType member would behave
 * identically here; do NOT add an "enhance" member just for this.
 */
export async function enhanceProse(
  body: string,
  config: ProviderConfig,
  override?: string,
): Promise<EnrichResult> {
  // Unlike promoteIdea, the URL is asserted too (matching enrichSharedLink):
  // a blank base URL must surface as not-configured rather than as an opaque
  // fetch error — the defect fixed in #29.
  const model = assertModelConfigured(config.model, config.label);
  assertUrlConfigured(config.baseUrl, config.label);
  return chatCompletion(
    config.baseUrl,
    config.apiKey,
    model,
    withSystemOverride(buildEnhanceProsePrompt(body), override),
    "journal",
    config.label,
    ENHANCE_TIMEOUT_MS,
  );
}

// Error type and status-classification predicates live in ./llmErrors.
// Re-exported so importers of ./llmClient keep their import path unchanged.
export {
  LlmClientError,
  isPermanentError,
  isNotConfiguredError,
  isInsecureTransportError,
} from "./llmErrors";

// Config-precondition guards (blank URL/model/vision-model, image size,
// HTTPS-or-local transport) live in ./llmGuards. Re-exported for the same
// reason.
export {
  MAX_SHARED_IMAGE_BYTES,
  assertBase64UnderLimit,
  assertVisionReady,
} from "./llmGuards";
