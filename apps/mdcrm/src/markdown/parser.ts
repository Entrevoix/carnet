import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";

import type { AnyRecord, MarkdownRecord } from "../models/records.js";

export class MarkdownParseError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "MarkdownParseError";
  }
}

export function parseMarkdownRecord(markdown: string, sourcePath?: string): MarkdownRecord {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new MarkdownParseError("missing opening YAML frontmatter delimiter", sourcePath);
  }
  const normalized = markdown.replace(/\r\n/g, "\n");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    throw new MarkdownParseError("missing closing YAML frontmatter delimiter", sourcePath);
  }
  const yamlText = normalized.slice(4, closing);
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new MarkdownParseError(`invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`, sourcePath);
  }
  const frontmatter: unknown = document.toJS({ maxAliasCount: 0 });
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new MarkdownParseError("frontmatter must be a mapping", sourcePath);
  }
  return {
    frontmatter: frontmatter as AnyRecord,
    body: normalized.slice(closing + 5),
    ...(sourcePath ? { sourcePath } : {}),
    contentSha256: sha256(markdown),
  };
}

export function renderMarkdownRecord(record: Pick<MarkdownRecord, "frontmatter" | "body">): string {
  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${record.body.replace(/^\n+/, "")}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Assert a record carries the on-disk content hash that optimistic writes and
 * revision-conflict checks compare against. A record built in memory has none.
 */
export function requireContentHash(record: Pick<MarkdownRecord, "contentSha256"> | null): string {
  if (!record?.contentSha256) throw new Error("Record hash missing");
  return record.contentSha256;
}

/** First ATX H1 in a body, or null. Backs both record filenames and index titles. */
export function firstHeading(body: string): string | null {
  return body.split("\n").find((line) => line.startsWith("# "))?.slice(2).trim() || null;
}

/** Hash logical content without the revision block to avoid a self-referential hash. */
export function logicalRecordHash(record: Pick<MarkdownRecord, "frontmatter" | "body">): string {
  const frontmatter = structuredClone(record.frontmatter) as AnyRecord;
  delete frontmatter.revision;
  return sha256(renderMarkdownRecord({ frontmatter, body: record.body }));
}
