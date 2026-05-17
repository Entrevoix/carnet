/**
 * OmniRoute LLM chat client for carnet v0.2.
 *
 * Posts to the OpenAI-compatible `/v1/chat/completions` endpoint at the
 * configured OmniRoute base URL. Reads `omniRouteUrl` and `omniRouteApiKey`
 * from settings.
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
} from "./prompts";
import type { IdeaStatus } from "@carnet/shared";

export interface EnrichResult {
  markdown: string;
  model: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
 * Low-level POST to /v1/chat/completions. Returns the text content of
 * choices[0].message.content and the model string.
 */
async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  prompt: string,
): Promise<EnrichResult> {
  const url = `${baseUrl.trim().replace(/\/+$/, "")}/v1/chat/completions`;

  const body = JSON.stringify({
    messages: [{ role: "user", content: prompt }],
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as OpenAIResponse;
      if (errBody.error?.message) {
        detail += `: ${errBody.error.message}`;
      }
    } catch {
      // ignore parse failure — original status message is enough
    }
    throw new Error(`OmniRoute error — ${detail}`);
  }

  const json = (await response.json()) as OpenAIResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim().length) {
    throw new Error("OmniRoute returned an empty or malformed response");
  }

  // Strip defensive code fences that some models add.
  const markdown = stripCodeFences(content);
  const model = json.model ?? "unknown";

  return { markdown, model };
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
    throw new Error("OmniRoute URL not configured — set it in Settings");
  }
  return url;
}

async function getApiKey(): Promise<string> {
  const settings = await getSettings();
  return settings.omniRouteApiKey ?? "";
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enrich a raw idea text into structured Obsidian markdown. */
export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey] = await Promise.all([getBaseUrl(), getApiKey()]);
  const prompt = buildIdeaPrompt(text);
  return chatCompletion(baseUrl, apiKey, prompt);
}

/** Enrich a journal voice transcript (plus optional notes) into a journal entry. */
export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey] = await Promise.all([getBaseUrl(), getApiKey()]);
  const prompt = buildJournalPrompt(input.transcript, input.notes);
  return chatCompletion(baseUrl, apiKey, prompt);
}

/** Enrich a business card OCR result + context into a contact note. */
export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey] = await Promise.all([getBaseUrl(), getApiKey()]);
  const prompt = buildPersonPrompt(input.ocrResult, input.context);
  return chatCompletion(baseUrl, apiKey, prompt);
}

/**
 * Rewrite an existing idea note to reflect a new status level.
 * Returns the updated markdown and the model used.
 */
export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
): Promise<EnrichResult> {
  const [baseUrl, apiKey] = await Promise.all([getBaseUrl(), getApiKey()]);
  const prompt = buildPromoteIdeaPrompt(currentMarkdown, target);
  return chatCompletion(baseUrl, apiKey, prompt);
}
