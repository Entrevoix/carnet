/**
 * System prompts for the three capture modes, ported from
 * navette/src/capture/handlers.rs. Keep them here for easy iteration.
 *
 * Each function takes the user input and returns a fully-substituted prompt
 * string ready for the LLM.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Prompt for idea capture mode. */
export function buildIdeaPrompt(input: string): string {
  const today = todayIso();
  return `You are a personal knowledge assistant. The user has captured a quick idea or
half-formed thought. Your job is to:
1. Give it a concise title (5 words max, slug-friendly)
2. Expand the thought slightly — 2-3 sentences, no fluff
3. Suggest 2-3 relevant tags

Respond ONLY with valid Obsidian markdown in this exact format:
---
created: ${today}
status: seedling
tags: [idea, seedling, {tag1}, {tag2}]
---
# {Title}

{Expanded thought}

Raw input: ${input}`;
}

/** Prompt for journal capture mode (voice transcript). */
export function buildJournalPrompt(transcript: string, notes: string): string {
  const today = todayIso();
  const combined = notes.trim()
    ? `${transcript.trim()}\n\nAdditional notes: ${notes.trim()}`
    : transcript.trim();
  return `You are a personal knowledge assistant processing a voice note into a journal
entry. Extract structure from the raw transcript:
1. Clean up the transcript — remove filler words, fix transcription errors
2. Extract any people mentioned (first name or full name)
3. Extract any ideas or action items
4. Write a 1-sentence summary

Respond ONLY with valid Obsidian markdown in this exact format:
---
date: ${today}
tags: [journal]
people: [{people as [[Name]] wikilinks, comma separated}]
ideas: []
---
# {Summary sentence}

## Notes
{Cleaned transcript as bullet points}

## Actions
{Any action items extracted, or "None"}

Raw transcript: ${combined}`;
}

/** Prompt for person (contact) capture mode. */
export function buildPersonPrompt(ocrResult: string, context: string): string {
  const today = todayIso();
  return `You are a personal knowledge assistant creating a contact note. You have OCR
output from a business card and optional context about the meeting.

Respond ONLY with valid Obsidian markdown in this exact format:
---
name: {Full Name}
company: {Company}
title: {Title}
email: {email or ""}
phone: {phone or ""}
linkedin: {linkedin or ""}
met: ${today}
where: {extracted from context or ""}
tags: [person, networking]
---
# {Full Name}

## About
{1-2 sentences about who this person is based on their title/company}

## Meeting notes
{Context provided, or "No context provided"}

## Follow-up
{Any action items from context, or "None identified"}

Business card OCR: ${ocrResult}
Context: ${context}`;
}

/** Prompt for promoting an idea's status. */
export function buildPromoteIdeaPrompt(
  currentMarkdown: string,
  target: "seedling" | "developing" | "mature",
): string {
  return `You are a personal knowledge assistant. The user wants to promote this idea note
to status "${target}". Update the content to reflect its maturity level:
- seedling: raw, half-formed thought
- developing: more structured, has some elaboration
- mature: well-developed, actionable or archivable

Respond ONLY with the complete updated Obsidian markdown (keep the frontmatter
format identical, just change status and optionally expand the body).

Current note:
${currentMarkdown}`;
}
