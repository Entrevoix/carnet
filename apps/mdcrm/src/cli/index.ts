#!/usr/bin/env node
import { basename, extname } from "node:path";

import { loadConfig } from "../config/config.js";
import { createStructuredLogger } from "../logging/logger.js";
import { recordReferences } from "../markdown/links.js";
import { rebuildFullTextIndex, searchFullText } from "../indexing/fullText.js";
import { rankContactCandidates } from "../matching/contactMatcher.js";
import type {
  CaptureRecord, ContactRecord, EventRecord, MarkdownRecord, OrganizationRecord, ReviewItemRecord,
} from "../models/records.js";
import { normalizeEmail, normalizeIsoDate, normalizeName, normalizeOrganization, normalizePhone, normalizeUrl } from "../normalization/values.js";
import { processCapture } from "../processors/capturePipeline.js";
import { processInbox } from "../processors/inbox.js";
import { FileSystemRepository } from "../storage/repository.js";

const EXIT_USAGE = 2;
const EXIT_VALIDATION = 3;
const EXIT_CONFLICT = 4;

interface CliContext { repository: FileSystemRepository; json: boolean; args: string[] }

async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = takeFlag(argv, "--json");
  const configPath = takeOption(argv, "--config");
  const rootOverride = takeOption(argv, "--root");
  const config = await loadConfig(configPath);
  if (rootOverride) config.knowledgeBasePath = rootOverride;
  const repository = new FileSystemRepository(config.knowledgeBasePath);
  const command = argv.shift();
  const context: CliContext = { repository, json, args: argv };
  if (!command || command === "help" || command === "--help") return printHelp();

  switch (command) {
    case "init": await repository.initialize(); return output(context, { root: repository.root, initialized: true });
    case "validate": return validateCommand(context);
    case "scan-inbox": return scanCommand(context);
    case "process-inbox": return processInboxCommand(context, config);
    case "process-capture": return processCommand(context, config);
    case "classify": return classifyCommand(context);
    case "extract": return extractCommand(context);
    case "normalize": return normalizeCommand(context);
    case "match-contact": return matchCommand(context);
    case "match-company": return matchCompanyCommand(context);
    case "link-event": return linkEventCommand(context);
    case "rebuild-index": return indexCommand(context);
    case "search": return searchCommand(context);
    case "review": return reviewCommand(context);
    case "doctor": return doctorCommand(context);
    default: throw new UsageError(`Unknown command: ${command}`);
  }
}

async function validateCommand(context: CliContext): Promise<number> {
  const path = requiredArg(context.args, "Markdown path");
  const record = await context.repository.readPath(path);
  context.repository.schemas.validate(record.frontmatter, record.sourcePath);
  if (record.frontmatter.type === "capture") await context.repository.verifyAttachments(record);
  return output(context, { valid: true, id: record.frontmatter.id, type: record.frontmatter.type, path: record.sourcePath });
}

async function scanCommand(context: CliContext): Promise<number> {
  const captures = (await context.repository.listRecords("capture"))
    .filter((record): record is MarkdownRecord<CaptureRecord> => record.frontmatter.type === "capture")
    .filter((record) => ["captured", "queued", "failed"].includes(record.frontmatter.processing_status))
    .map((record) => ({ id: record.frontmatter.id, state: record.frontmatter.processing_status, path: record.sourcePath }));
  return output(context, { captures });
}

async function processCommand(context: CliContext, config: Awaited<ReturnType<typeof loadConfig>>): Promise<number> {
  const id = requiredArg(context.args, "Capture id");
  return output(context, await processCapture(context.repository, config, id, createStructuredLogger()));
}

async function processInboxCommand(context: CliContext, config: Awaited<ReturnType<typeof loadConfig>>): Promise<number> {
  const result = await processInbox(context.repository, config, createStructuredLogger());
  output(context, result);
  return result.failed.length === 0 ? 0 : 1;
}

async function captureForCommand(context: CliContext): Promise<MarkdownRecord<CaptureRecord>> {
  const id = requiredArg(context.args, "Capture id");
  const record = await context.repository.readById(id);
  if (!record || record.frontmatter.type !== "capture") throw new Error(`Capture not found: ${id}`);
  return record as MarkdownRecord<CaptureRecord>;
}

async function classifyCommand(context: CliContext): Promise<number> {
  const capture = await captureForCommand(context);
  return output(context, { capture_id: capture.frontmatter.id, classification: { type: capture.frontmatter.capture_kind, confidence: 1, source: "observed" } });
}

async function extractCommand(context: CliContext): Promise<number> {
  const capture = await captureForCommand(context);
  return output(context, { capture_id: capture.frontmatter.id, extracted: capture.frontmatter.extracted ?? {}, source: "capture" });
}

async function normalizeCommand(context: CliContext): Promise<number> {
  const kind = requiredArg(context.args, "Normalization kind");
  const value = requiredArg(context.args, "Value");
  const country = takeOption(context.args, "--country-code");
  const functions: Record<string, (input: string) => string> = {
    email: normalizeEmail, phone: (input) => normalizePhone(input, country), name: normalizeName,
    company: normalizeOrganization, url: normalizeUrl, date: normalizeIsoDate,
  };
  const normalize = functions[kind];
  if (!normalize) throw new UsageError(`Unknown normalization kind: ${kind}`);
  return output(context, { kind, input: value, normalized: normalize(value) });
}

async function matchCommand(context: CliContext): Promise<number> {
  const id = requiredArg(context.args, "Capture id");
  const capture = await context.repository.readById(id);
  if (!capture || capture.frontmatter.type !== "capture") throw new Error(`Capture not found: ${id}`);
  const contacts = (await context.repository.listRecords("contact"))
    .filter((record): record is MarkdownRecord<ContactRecord> => record.frontmatter.type === "contact")
    .map((record) => record.frontmatter);
  return output(context, { candidates: rankContactCandidates(capture.frontmatter, contacts).map((candidate) => ({ id: candidate.contact.id, score: candidate.score, evidence: candidate.evidence })) });
}

async function matchCompanyCommand(context: CliContext): Promise<number> {
  const capture = await captureForCommand(context);
  const normalized = normalizeOrganization(capture.frontmatter.extracted?.company ?? "");
  const matches = (await context.repository.listRecords("organization"))
    .filter((record): record is MarkdownRecord<OrganizationRecord> => record.frontmatter.type === "organization")
    .filter((record) => record.frontmatter.name.normalized === normalized)
    .map((record) => ({ id: record.frontmatter.id, match: "exact_normalized_name" }));
  return output(context, { capture_id: capture.frontmatter.id, normalized, matches });
}

async function linkEventCommand(context: CliContext): Promise<number> {
  const capture = await captureForCommand(context);
  const eventId = capture.frontmatter.event_context?.event_id;
  const name = normalizeName(capture.frontmatter.event_context?.event_name ?? "");
  const date = capture.frontmatter.event_context?.event_date;
  const matches = (await context.repository.listRecords("event"))
    .filter((record): record is MarkdownRecord<EventRecord> => record.frontmatter.type === "event")
    .filter((record) => eventId ? record.frontmatter.id === eventId : normalizeName(record.frontmatter.name) === name && (!date || record.frontmatter.start_at?.startsWith(date)))
    .map((record) => ({ id: record.frontmatter.id, match: eventId ? "exact_id" : "exact_normalized_name_and_date" }));
  return output(context, { capture_id: capture.frontmatter.id, matches });
}

async function indexCommand(context: CliContext): Promise<number> {
  const index = await rebuildFullTextIndex(context.repository);
  return output(context, { documents: Object.keys(index.documents).length, terms: Object.keys(index.terms).length, generated_at: index.generated_at });
}

async function searchCommand(context: CliContext): Promise<number> {
  const query = context.args.join(" ").trim(); if (!query) throw new UsageError("Search query is required");
  return output(context, { results: await searchFullText(context.repository, query) });
}

async function reviewCommand(context: CliContext): Promise<number> {
  const action = context.args.shift() ?? "list";
  if (action === "list") {
    const items = (await context.repository.listRecords("review_item"))
      .filter((record): record is MarkdownRecord<ReviewItemRecord> => record.frontmatter.type === "review_item")
      .filter((record) => record.frontmatter.state === "open");
    return output(context, { reviews: items.map((item) => ({ id: item.frontmatter.id, review_type: item.frontmatter.review_type, source_capture_id: item.frontmatter.source_capture_id })) });
  }
  if (action !== "approve" && action !== "reject") throw new UsageError(`Unknown review action: ${action}`);
  const id = requiredArg(context.args, "Review id");
  const record = await context.repository.readById(id);
  if (!record || record.frontmatter.type !== "review_item") throw new Error(`Review not found: ${id}`);
  const updated: ReviewItemRecord = { ...record.frontmatter, state: action === "approve" ? "approved" : "rejected", updated_at: new Date().toISOString() };
  const filename = record.sourcePath ? basename(record.sourcePath, extname(record.sourcePath)) : record.frontmatter.id;
  await context.repository.writeRecord({ frontmatter: updated, body: record.body }, { overwrite: true, expectedContentSha256: requireHash(record), filenameHint: filename });
  return output(context, { id, state: updated.state });
}

async function doctorCommand(context: CliContext): Promise<number> {
  await context.repository.initialize();
  const issues: Array<{ path?: string; message: string }> = [];
  const ids = new Map<string, string>();
  const records: MarkdownRecord[] = [];
  for (const path of await context.repository.listRecordPaths()) {
    try { records.push(await context.repository.readPath(path)); }
    catch (error: unknown) { issues.push({ path, message: error instanceof Error ? error.message : "unable to read record" }); }
  }
  for (const record of records) {
    try { context.repository.schemas.validate(record.frontmatter, record.sourcePath); }
    catch (error: unknown) { issues.push({ ...(record.sourcePath ? { path: record.sourcePath } : {}), message: error instanceof Error ? error.message : "validation failed" }); }
    const prior = ids.get(record.frontmatter.id);
    if (prior) issues.push({ ...(record.sourcePath ? { path: record.sourcePath } : {}), message: `duplicate id also found at ${prior}` });
    else ids.set(record.frontmatter.id, record.sourcePath ?? "");
    if (record.frontmatter.type === "capture") {
      try { await context.repository.verifyAttachments(record); }
      catch (error: unknown) { issues.push({ ...(record.sourcePath ? { path: record.sourcePath } : {}), message: error instanceof Error ? error.message : "attachment check failed" }); }
    }
  }
  for (const record of records) {
    for (const reference of recordReferences(record.frontmatter)) {
      if (!ids.has(reference)) issues.push({ ...(record.sourcePath ? { path: record.sourcePath } : {}), message: `broken internal reference: ${reference}` });
    }
  }
  output(context, { healthy: issues.length === 0, records: ids.size, issues });
  return issues.length === 0 ? 0 : EXIT_VALIDATION;
}

function output(context: CliContext, value: unknown): number {
  if (context.json) console.log(JSON.stringify(value));
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return 0;
}
function takeFlag(args: string[], flag: string): boolean { const index = args.indexOf(flag); if (index < 0) return false; args.splice(index, 1); return true; }
function takeOption(args: string[], option: string): string | undefined { const index = args.indexOf(option); if (index < 0) return undefined; const value = args[index + 1]; if (!value) throw new UsageError(`${option} requires a value`); args.splice(index, 2); return value; }
function requiredArg(args: string[], label: string): string { const value = args.shift(); if (!value) throw new UsageError(`${label} is required`); return value; }
function requireHash(record: MarkdownRecord): string { if (!record.contentSha256) throw new Error("Record hash missing"); return record.contentSha256; }
function printHelp(): number { console.log(`mdcrm <command> [--root PATH] [--config FILE] [--json]\n\nCommands:\n  init\n  validate FILE\n  scan-inbox\n  process-inbox\n  process-capture CAPTURE_ID\n  classify CAPTURE_ID\n  extract CAPTURE_ID\n  normalize email|phone|name|company|url|date VALUE\n  match-contact CAPTURE_ID\n  match-company CAPTURE_ID\n  link-event CAPTURE_ID\n  rebuild-index\n  search QUERY\n  review list|approve|reject [REVIEW_ID]\n  doctor`); return 0; }
class UsageError extends Error {}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }));
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : message.includes("changed since processing") ? EXIT_CONFLICT : message.includes("valid") ? EXIT_VALIDATION : 1;
});
