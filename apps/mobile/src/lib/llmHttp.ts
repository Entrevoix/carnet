/**
 * Low-level OpenAI-compatible chat wire types and the fetch primitives built
 * on them, for the merged LLM client (./llmClient). Split out of
 * llmClient.ts as a move-only extraction — see llmClient.ts's module
 * comment for the full decomposition map.
 */

import { sanitizeAndNormalize, sanitizeMarkdown, type NoteType } from "./enrichSanitize";
import type { PromptPair } from "./prompts";
import { parseErrorBody, sanitizeErrorMessage, withTimeout } from "./httpClient";
import { LlmClientError, timeoutError } from "./llmErrors";
import { assertHttpsOrLocal, assertUrlConfigured } from "./llmGuards";
// Type-only — no runtime import, so this cannot form a cycle with
// llmClient.ts (which imports executeChat/chatCompletion from here at
// runtime). Same pattern as syncConflicts.ts's `import type { NoteFileRef }
// from "./writer"`.
import type { EnrichResult } from "./llmClient";

/** OpenAI-compatible content part for multimodal messages. `input_audio`
 * is the OpenAI shape that LiteLLM bridges to Gemini's audio modality and
 * to OpenAI's own gpt-4o-audio-preview. `format` is the file extension
 * minus the dot (e.g. "m4a", "mp3", "wav"). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  /** String for text-only, array for multimodal (image + text). */
  content: string | ContentPart[];
}

export interface OpenAIChoice {
  message: OpenAIMessage;
}

export interface OpenAIResponse {
  model?: string;
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

// Hard ceiling on any single request. Kept short because an unreachable host
// (e.g. a gateway on a tailnet with Tailscale down) must fail fast so the
// caller's offline-queue path fires instead of spinning.
// Trade-off: a genuine generation that runs longer than this is cut off.
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Longer ceiling for Enhance. The 20s above is tuned for CAPTURE, where an
 * unreachable host must fail fast so the offline queue takes over — but
 * Enhance has no queue path (it rewrites a note already on disk), is
 * explicitly user-initiated, and exists precisely to run a slower, stronger
 * model. Measured on-device 2026-08-05: `auto/best-reasoning` over a tailnet
 * blew past 20s, timed out, fell through to the Relais fallback, and surfaced
 * as "Local LLM model not configured" — i.e. the 20s cap made the feature's
 * headline use case (pick a better model) fail, and fail misleadingly.
 */
export const ENHANCE_TIMEOUT_MS = 120_000;

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
export async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  noteType: NoteType,
  label: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<EnrichResult> {
  const trimmed = assertUrlConfigured(baseUrl, label);
  const trimmedUrl = trimmed.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmedUrl, label);

  const url = `${trimmedUrl}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await withTimeout(
    timeoutMs,
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
export async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: PromptPair,
  noteType: NoteType,
  label: string,
  timeoutMs?: number,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages, noteType, label, timeoutMs);
}

/** Strip a leading ``` fence (and matching trailer). Does not trim unfenced content. */
export function stripCodeFences(raw: string): string {
  const leftTrimmed = raw.trimStart();
  if (!leftTrimmed.startsWith("```")) return raw;
  const rest = leftTrimmed.slice(3);
  const afterLang = rest.includes("\n") ? rest.slice(rest.indexOf("\n") + 1) : rest;
  const stripped = afterLang.trimEnd().endsWith("```")
    ? afterLang.trimEnd().slice(0, -3).trimEnd()
    : afterLang;
  return stripped;
}
