export const FACT_STATUSES = [
  "observed",
  "normalized",
  "inferred",
  "suggested",
  "user_confirmed",
  "rejected",
  "superseded",
] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const PROCESSING_STATES = [
  "captured",
  "normalized",
  "synced",
  "queued",
  "processing",
  "review_required",
  "completed",
  "failed",
] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

export type RecordType =
  | "capture"
  | "contact"
  | "organization"
  | "event"
  | "interaction"
  | "task"
  | "review_item"
  | "processing_job"
  | "proposed_change";

export interface Revision {
  number: number;
  content_sha256: string;
  previous_content_sha256?: string;
}

export interface Provenance {
  source_type: "capture" | "inference" | "user" | "processor";
  source_id?: string;
  source_ids?: string[];
  extraction_method: string;
  processor: string;
  processor_version: string;
  model?: string;
  prompt_version?: string;
  confidence?: number;
  created_at: string;
}

export interface BaseRecord {
  schema_version: 1;
  type: RecordType;
  id: string;
  created_at?: string;
  updated_at?: string;
  revision?: Revision;
  provenance?: Provenance[];
}

export interface AttachmentRef {
  id: string;
  role: "original" | "derived" | "thumbnail" | "supporting";
  path: string;
  media_type: string;
  sha256: string;
}

export interface CaptureRecord extends BaseRecord {
  type: "capture";
  created_at: string;
  updated_at: string;
  captured_by: string;
  capture_method: string;
  capture_kind: string;
  processing_status: ProcessingState;
  review_status: "unreviewed" | "review_required" | "approved" | "rejected";
  event_context?: {
    event_id?: string | null;
    event_name?: string | null;
    event_date?: string | null;
    location?: string | null;
  };
  attachments: AttachmentRef[];
  ocr?: {
    engine: string;
    engine_version?: string;
    completed_at?: string;
    language_hints?: string[];
    raw_text_path: string;
    corrected_text_path?: string;
  };
  extracted?: {
    name?: string;
    title?: string;
    company?: string;
    email?: string;
    phone_display?: string;
    phone_normalized?: string;
    website?: string;
  };
  confidence?: Record<string, number>;
  sync?: {
    state: "local_only" | "pending" | "uploading" | "synced" | "conflict" | "failed";
    attempts: number;
    last_attempt_at?: string | null;
    remote_revision?: string | null;
  };
}

export interface ContactRecord extends BaseRecord {
  type: "contact";
  name: { display: string; given?: string; family?: string; normalized: string };
  title?: string;
  organization?: { id?: string; name: string };
  emails: Array<{ value: string; normalized: string; type?: string; status: FactStatus; source_capture_id: string }>;
  phones: Array<{ display: string; normalized: string; type?: string; status: FactStatus; source_capture_id: string }>;
  websites?: string[];
  record_status: "active" | "superseded" | "archived";
  verification_status: "unverified" | "verified";
  source_capture_ids: string[];
  tags?: string[];
  canonical_contact_id?: string;
}

export interface OrganizationRecord extends BaseRecord {
  type: "organization";
  name: { display: string; normalized: string };
  aliases: string[];
  domains: string[];
  source_capture_ids: string[];
  contact_ids?: string[];
}

export interface EventRecord extends BaseRecord {
  type: "event";
  name: string;
  start_at?: string;
  end_at?: string;
  location?: { display: string; venue?: string; city?: string; country?: string };
  contact_ids: string[];
  capture_ids: string[];
}

export interface InteractionRecord extends BaseRecord {
  type: "interaction";
  occurred_at: string;
  interaction_type: string;
  contact_ids: string[];
  organization_ids: string[];
  event_id?: string;
  source_capture_ids: string[];
  follow_up?: { required: boolean; suggested_date?: string; status: "open" | "completed" | "dismissed" };
  created_by: string;
}

export interface TaskRecord extends BaseRecord {
  type: "task";
  title: string;
  state: "open" | "completed" | "dismissed";
  due_at?: string;
  source_capture_ids: string[];
  contact_ids?: string[];
}

export interface ReviewItemRecord extends BaseRecord {
  type: "review_item";
  review_type: "possible_duplicate" | "field_conflict" | "low_ocr_confidence" | "unknown_document_type" | "event_match" | "company_match" | "contact_match" | "task_suggestion" | "follow_up_suggestion" | "revision_conflict";
  state: "open" | "approved" | "rejected";
  priority: "low" | "normal" | "high";
  source_capture_id: string;
  candidate_contact_ids?: string[];
  recommended_contact_id?: string;
  confidence?: number;
  evidence?: string[];
}

export interface ProcessingJobRecord extends BaseRecord {
  type: "processing_job";
  capture_id: string;
  pipeline: string;
  idempotency_key: string;
  source_revision: string;
  state: "queued" | "processing" | "review_required" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  stages: Array<{ name: string; state: "queued" | "processing" | "review_required" | "completed" | "failed"; error?: string }>;
  outputs: Record<string, string | string[]>;
}

export interface ProposedChangeRecord extends BaseRecord {
  type: "proposed_change";
  target_id: string;
  target_revision: number;
  changes: Array<{ operation: "add" | "remove" | "replace"; path: string; value?: unknown; old_value?: unknown; confidence?: number }>;
}

export type AnyRecord =
  | CaptureRecord
  | ContactRecord
  | OrganizationRecord
  | EventRecord
  | InteractionRecord
  | TaskRecord
  | ReviewItemRecord
  | ProcessingJobRecord
  | ProposedChangeRecord;

export interface MarkdownRecord<T extends AnyRecord = AnyRecord> {
  frontmatter: T;
  body: string;
  sourcePath?: string;
  contentSha256?: string;
}
