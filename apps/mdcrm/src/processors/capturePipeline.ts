import type { MdcrmConfig } from "../config/config.js";
import { idempotencyKey } from "../jobs/idempotency.js";
import { requireContentHash } from "../markdown/parser.js";
import { rebuildFullTextIndex } from "../indexing/fullText.js";
import { NOOP_LOGGER, type Logger } from "../logging/logger.js";
import { rankContactCandidates, type MatchReason } from "../matching/contactMatcher.js";
import { createId } from "../models/ids.js";
import type {
  CaptureRecord, ContactRecord, EventRecord, InteractionRecord, MarkdownRecord,
  OrganizationRecord, ProcessingJobRecord, ReviewItemRecord,
} from "../models/records.js";
import { normalizeEmail, normalizeName, normalizeOrganization, normalizePhone, normalizeUrl } from "../normalization/values.js";
import { possibleDuplicateReview } from "../review/createReview.js";
import { acquireLease } from "../storage/lease.js";
import { FileSystemRepository, RevisionConflictError } from "../storage/repository.js";

const PROCESSOR = "capture-pipeline";
const PROCESSOR_VERSION = "1.0.0";

export interface ProcessResult {
  jobId: string;
  state: ProcessingJobRecord["state"];
  outputs: ProcessingJobRecord["outputs"];
  reused: boolean;
}

export async function processCapture(
  repository: FileSystemRepository,
  config: MdcrmConfig,
  captureId: string,
  logger: Logger = NOOP_LOGGER,
): Promise<ProcessResult> {
  const started = Date.now();
  logger.log({ level: "info", processor: PROCESSOR, processor_version: PROCESSOR_VERSION, capture_id: captureId, stage: "discover", message: "Processing capture" });
  await repository.initialize();
  const source = await repository.readById(captureId);
  if (!source || source.frontmatter.type !== "capture") throw new Error(`Capture not found: ${captureId}`);
  repository.schemas.validate(source.frontmatter, source.sourcePath);
  await repository.verifyAttachments(source);
  const captureSource = source as MarkdownRecord<CaptureRecord>;
  const sourceRevision = requireContentHash(captureSource);
  const key = idempotencyKey(PROCESSOR, PROCESSOR_VERSION, captureId, sourceRevision);
  const prior = (await repository.listRecords("processing_job"))
    .find((record) => record.frontmatter.type === "processing_job" && record.frontmatter.idempotency_key === key);
  if (prior?.frontmatter.type === "processing_job" && ["completed", "review_required"].includes(prior.frontmatter.state)) {
    return { jobId: prior.frontmatter.id, state: prior.frontmatter.state, outputs: prior.frontmatter.outputs, reused: true };
  }

  const lease = await acquireLease(repository.root, captureId, config.leaseSeconds);
  try {
    const result = await processUnderLease(repository, config, captureSource, key, prior?.frontmatter.type === "processing_job" ? prior as MarkdownRecord<ProcessingJobRecord> : null);
    logger.log({ level: "info", processor: PROCESSOR, processor_version: PROCESSOR_VERSION, capture_id: captureId, job_id: result.jobId, stage: "complete", message: `Processing ${result.state}`, duration_ms: Date.now() - started });
    return result;
  } finally {
    await lease.release();
  }
}

async function processUnderLease(
  repository: FileSystemRepository,
  config: MdcrmConfig,
  source: MarkdownRecord<CaptureRecord>,
  key: string,
  priorJob: MarkdownRecord<ProcessingJobRecord> | null,
): Promise<ProcessResult> {
  const now = new Date();
  const createdOutputs: Array<{ path: string; contentSha256: string }> = [];
  const contacts = (await repository.listRecords("contact"))
    .filter((record): record is MarkdownRecord<ContactRecord> => record.frontmatter.type === "contact")
    .map((record) => record.frontmatter);
  const candidates = rankContactCandidates(source.frontmatter, contacts);
  const top = candidates[0];
  // An exact identifier only *identifies* someone when exactly one contact
  // holds it. Two records sharing an email is an ordinary import artifact, and
  // auto-linking there would bind the interaction to whichever id happens to
  // sort first. Ambiguity is what the review queue is for.
  const uniquelyHolds = (reason: MatchReason): boolean =>
    (top?.reasons.includes(reason) ?? false)
    && candidates.filter((candidate) => candidate.reasons.includes(reason)).length === 1;
  const exactEmail = uniquelyHolds("exact_email");
  const exactPhone = uniquelyHolds("exact_phone");
  const automaticMatch = Boolean(top && (exactPhone || (exactEmail && config.processing.autoCreateContactOnExactEmail)) && top.score >= config.matching.automaticMatchThreshold);
  const needsReview = Boolean(top && !automaticMatch && top.score >= config.matching.reviewThreshold);

  const planned = priorJob?.frontmatter.outputs ?? planOutputIds(source.frontmatter, automaticMatch ? top?.contact.id : undefined, needsReview);
  let job = priorJob?.frontmatter ?? buildJob(source.frontmatter.id, requireContentHash(source), key, planned, now);
  let jobRecord = priorJob;
  if (!jobRecord) {
    const path = await repository.writeRecord({ frontmatter: job, body: jobBody(job) }, { filenameHint: job.id });
    jobRecord = await repository.readPath(path) as MarkdownRecord<ProcessingJobRecord>;
    job = jobRecord.frontmatter;
  }

  await assertSourceUnchanged(repository, source);

  try {
    if (needsReview) {
      const reviewId = stringOutput(planned.review_item_id);
      if (!(await repository.readById(reviewId))) {
        await assertSourceUnchanged(repository, source);
        const review = possibleDuplicateReview(source.frontmatter.id, candidates.slice(0, 5), now, reviewId);
        createdOutputs.push(await trackCreatedOutput(repository, await repository.writeRecord({ frontmatter: review, body: reviewBody(review) }, { filenameHint: `${review.id}-possible-duplicate` })));
      }
      job = { ...job, state: "review_required", stages: completedStages("review_required") };
    } else {
      const contactId = automaticMatch ? top?.contact.id : stringOutput(planned.contact_id);
      if (!contactId) throw new Error("Pipeline did not plan a contact id");
      let organization: OrganizationRecord | null = null;
      if (!automaticMatch && source.frontmatter.extracted?.company) {
        await assertSourceUnchanged(repository, source);
        organization = await resolveOrCreateOrganization(repository, source.frontmatter, stringOutput(planned.organization_id), contactId, now, createdOutputs);
      }
      if (!automaticMatch && !(await repository.readById(contactId))) {
        await assertSourceUnchanged(repository, source);
        const contact = buildContact(source.frontmatter, contactId, organization, now);
        createdOutputs.push(await trackCreatedOutput(repository, await repository.writeRecord({ frontmatter: contact, body: contactBody(contact) }, { filenameHint: `${contact.id}-${contact.name.display}` })));
      }
      const hasEventContext = Boolean(source.frontmatter.event_context?.event_id || source.frontmatter.event_context?.event_name);
      let event: EventRecord | null = null;
      if (hasEventContext) {
        await assertSourceUnchanged(repository, source);
        event = await resolveOrCreateEvent(repository, source.frontmatter, stringOutput(planned.event_id), contactId, now, createdOutputs);
      }
      if (config.processing.createInteractions) {
        const interactionId = stringOutput(planned.interaction_id);
        if (!(await repository.readById(interactionId))) {
          await assertSourceUnchanged(repository, source);
          const organizationId = organization?.id ?? (automaticMatch ? top?.contact.organization?.id : undefined);
          const interaction = buildInteraction(source.frontmatter, interactionId, contactId, organizationId, event?.id, now);
          createdOutputs.push(await trackCreatedOutput(repository, await repository.writeRecord({ frontmatter: interaction, body: interactionBody(interaction, source.frontmatter) }, { filenameHint: `${interaction.id}-${source.frontmatter.extracted?.name ?? "capture"}` })));
        }
      }
      job = { ...job, state: "completed", stages: completedStages("completed") };
    }
    if (config.indexing.fullText) await rebuildFullTextIndex(repository);
    // The final compare prevents a job from advertising stale derived outputs
    // when the user edited the source while a longer stage (such as indexing)
    // was running. A later run receives a new idempotency key for that edit.
    await assertSourceUnchanged(repository, source);
    job = { ...job, completed_at: new Date().toISOString() };
    const currentJob = await repository.readById(job.id);
    await repository.writeRecord(
      { frontmatter: job, body: jobBody(job) },
      { overwrite: true, expectedContentSha256: requireContentHash(currentJob), filenameHint: job.id },
    );
    return { jobId: job.id, state: job.state, outputs: job.outputs, reused: false };
  } catch (error: unknown) {
    if (error instanceof RevisionConflictError) {
      await Promise.all(createdOutputs.slice().reverse().map((output) => repository.deletePathIfUnchanged(output.path, output.contentSha256)));
      // The index was rebuilt before the final revision check, so it still
      // lists the records this rollback just removed. Leaving it stale makes
      // `search` return ids whose Markdown is gone until someone rebuilds by
      // hand. Best-effort: a failure here must not mask the original conflict.
      if (config.indexing.fullText) await rebuildFullTextIndex(repository).catch(() => undefined);
    }
    job = {
      ...job,
      state: "failed",
      completed_at: new Date().toISOString(),
      stages: [{ name: "process", state: "failed", error: error instanceof Error ? error.message : "unknown error" }],
    };
    const currentJob = await repository.readById(job.id);
    await repository.writeRecord({ frontmatter: job, body: jobBody(job) }, { overwrite: true, expectedContentSha256: requireContentHash(currentJob), filenameHint: job.id }).catch(() => undefined);
    throw error;
  }
}

function planOutputIds(capture: CaptureRecord, matchedContactId: string | undefined, review: boolean): ProcessingJobRecord["outputs"] {
  if (review) return { review_item_id: createId("review_item") };
  return {
    contact_id: matchedContactId ?? createId("contact"),
    ...(capture.extracted?.company && !matchedContactId ? { organization_id: createId("organization") } : {}),
    ...(capture.event_context?.event_id || capture.event_context?.event_name ? { event_id: createId("event") } : {}),
    interaction_id: createId("interaction"),
  };
}

function buildJob(captureId: string, revision: string, key: string, outputs: ProcessingJobRecord["outputs"], now: Date): ProcessingJobRecord {
  return { schema_version: 1, type: "processing_job", id: createId("processing_job", now.getTime()), capture_id: captureId,
    pipeline: `${PROCESSOR}-v1`, idempotency_key: key, source_revision: revision, state: "processing", started_at: now.toISOString(),
    stages: [{ name: "validate", state: "completed" }, { name: "match", state: "processing" }], outputs,
    provenance: [processorProvenance(captureId, now)] };
}

function buildContact(capture: CaptureRecord, id: string, organization: OrganizationRecord | null, now: Date): ContactRecord {
  const extracted = capture.extracted ?? {};
  const display = extracted.name?.trim() || "Unknown contact";
  const parts = display.split(/\s+/);
  const email = normalizeEmail(extracted.email ?? "");
  const phone = extracted.phone_normalized || normalizePhone(extracted.phone_display ?? "");
  const website = normalizeUrl(extracted.website ?? "");
  return { schema_version: 1, type: "contact", id,
    name: { display, given: parts[0] ?? display, ...(parts.length > 1 ? { family: parts.slice(1).join(" ") } : {}), normalized: normalizeName(display) || "unknown contact" },
    ...(extracted.title ? { title: extracted.title.trim() } : {}),
    ...(organization ? { organization: { id: organization.id, name: organization.name.display } } : extracted.company ? { organization: { name: extracted.company.trim() } } : {}),
    emails: email ? [{ value: extracted.email?.trim() ?? email, normalized: email, type: "work", status: "observed", source_capture_id: capture.id }] : [],
    phones: phone ? [{ display: extracted.phone_display?.trim() ?? phone, normalized: phone, type: "work", status: "normalized", source_capture_id: capture.id }] : [],
    ...(website ? { websites: [website] } : {}), record_status: "active", verification_status: "unverified", source_capture_ids: [capture.id],
    created_at: now.toISOString(), updated_at: now.toISOString(), provenance: [processorProvenance(capture.id, now)] };
}

async function resolveOrCreateOrganization(repository: FileSystemRepository, capture: CaptureRecord, plannedId: string, contactId: string, now: Date, createdOutputs: Array<{ path: string; contentSha256: string }>): Promise<OrganizationRecord | null> {
  const display = capture.extracted?.company?.trim(); if (!display) return null;
  const normalized = normalizeOrganization(display);
  const existing = (await repository.listRecords("organization")).find((record) => record.frontmatter.type === "organization" && record.frontmatter.name.normalized === normalized);
  if (existing?.frontmatter.type === "organization") return existing.frontmatter;
  const email = normalizeEmail(capture.extracted?.email ?? "");
  const domain = email.split("@")[1];
  const organization: OrganizationRecord = { schema_version: 1, type: "organization", id: plannedId,
    name: { display, normalized }, aliases: [], domains: domain ? [domain] : [], source_capture_ids: [capture.id], contact_ids: [contactId], created_at: now.toISOString(), updated_at: now.toISOString(), provenance: [processorProvenance(capture.id, now)] };
  createdOutputs.push(await trackCreatedOutput(repository, await repository.writeRecord({ frontmatter: organization, body: `# ${display}\n\n## Contacts\n\n- [[${contactId}]]\n` }, { filenameHint: `${organization.id}-${display}` })));
  return organization;
}

async function resolveOrCreateEvent(repository: FileSystemRepository, capture: CaptureRecord, plannedId: string, contactId: string, now: Date, createdOutputs: Array<{ path: string; contentSha256: string }>): Promise<EventRecord | null> {
  const context = capture.event_context;
  if (!context?.event_name && !context?.event_id) return null;
  if (context.event_id) {
    const existing = await repository.readById(context.event_id);
    if (existing?.frontmatter.type === "event") return existing.frontmatter;
  }
  const normalized = normalizeName(context.event_name ?? "");
  const existing = (await repository.listRecords("event")).find((record) =>
    record.frontmatter.type === "event"
      && normalizeName(record.frontmatter.name) === normalized
      && (!context.event_date || record.frontmatter.start_at?.startsWith(context.event_date)),
  );
  if (existing?.frontmatter.type === "event") return existing.frontmatter;
  const event: EventRecord = { schema_version: 1, type: "event", id: plannedId, name: context.event_name ?? "Unknown event",
    ...(context.event_date ? { start_at: `${context.event_date}T00:00:00Z` } : {}), ...(context.location ? { location: { display: context.location } } : {}),
    contact_ids: [contactId], capture_ids: [capture.id], created_at: now.toISOString(), updated_at: now.toISOString(), provenance: [processorProvenance(capture.id, now)] };
  createdOutputs.push(await trackCreatedOutput(repository, await repository.writeRecord({ frontmatter: event, body: `# ${event.name}\n\n## People\n\n- [[${contactId}]]\n\n## Captures\n\n- [[${capture.id}]]\n` }, { filenameHint: `${event.id}-${event.name}` })));
  return event;
}

function buildInteraction(capture: CaptureRecord, id: string, contactId: string, organizationId: string | undefined, eventId: string | undefined, now: Date): InteractionRecord {
  return { schema_version: 1, type: "interaction", id, occurred_at: capture.created_at, interaction_type: "in_person",
    contact_ids: [contactId], organization_ids: organizationId ? [organizationId] : [], ...(eventId ? { event_id: eventId } : {}),
    source_capture_ids: [capture.id], created_by: `${PROCESSOR}@${PROCESSOR_VERSION}`, created_at: now.toISOString(), provenance: [processorProvenance(capture.id, now)] };
}

function completedStages(finalState: "completed" | "review_required"): ProcessingJobRecord["stages"] {
  return ["validate", "verify_attachments", "normalize", "match", "derive", "index"].map((name) => ({ name, state: name === "match" && finalState === "review_required" ? "review_required" : "completed" }));
}
async function assertSourceUnchanged(repository: FileSystemRepository, source: MarkdownRecord<CaptureRecord>): Promise<void> {
  const latest = await repository.readById(source.frontmatter.id);
  if (!latest || latest.contentSha256 !== source.contentSha256) {
    throw new RevisionConflictError(source.sourcePath ?? source.frontmatter.id);
  }
}
async function trackCreatedOutput(repository: FileSystemRepository, path: string): Promise<{ path: string; contentSha256: string }> {
  const record = await repository.readPath(path);
  return { path, contentSha256: requireContentHash(record) };
}
function stringOutput(value: string | string[] | undefined): string { if (typeof value !== "string") throw new Error("Processing job output id is missing"); return value; }
function contactBody(contact: ContactRecord): string { return `# ${contact.name.display}\n\n${contact.organization ? `Works at [[${contact.organization.id ?? ""}|${contact.organization.name}]].\n` : ""}`; }
function interactionBody(interaction: InteractionRecord, capture: CaptureRecord): string { return `# ${capture.extracted?.name ?? "Contact"} — interaction\n\nContact: [[${interaction.contact_ids[0]}]]\n\nSource capture: [[${capture.id}]]\n${interaction.event_id ? `\nEvent: [[${interaction.event_id}]]\n` : ""}`; }
function reviewBody(review: ReviewItemRecord): string { return `# Possible duplicate\n\n## Evidence\n\n${(review.evidence ?? []).map((item) => `- ${item}`).join("\n")}\n`; }
function jobBody(job: ProcessingJobRecord): string { return `# Processing Job\n\nPipeline ${job.pipeline} for [[${job.capture_id}]] is **${job.state}**.\n`; }
function processorProvenance(captureId: string, now: Date) { return { source_type: "capture" as const, source_id: captureId, extraction_method: "deterministic", processor: PROCESSOR, processor_version: PROCESSOR_VERSION, created_at: now.toISOString() }; }
