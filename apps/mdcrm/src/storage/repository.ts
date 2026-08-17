import { access, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { MarkdownRecord, RecordType } from "../models/records.js";
import { firstHeading, logicalRecordHash, parseMarkdownRecord, renderMarkdownRecord, sha256 } from "../markdown/parser.js";
import { SchemaRegistry, bundledSchemaDirectory } from "../schemas/registry.js";
import { atomicWriteFile } from "./atomic.js";

const TYPE_DIRECTORIES: Record<RecordType, string> = {
  capture: "captures", contact: "contacts", organization: "organizations", event: "events",
  interaction: "interactions", task: "tasks", review_item: "review",
  processing_job: "processing/jobs", proposed_change: "processing/results",
};

const KB_DIRECTORIES = [
  "inbox/pending", "inbox/processing", "inbox/review", "inbox/completed", "inbox/failed",
  "captures", "contacts", "organizations", "events", "interactions", "tasks", "review",
  "attachments/originals", "attachments/derived", "attachments/thumbnails",
  "processing/results", "processing/errors", "processing/locks", "processing/jobs", "indexes", "schemas",
];

/**
 * Serialize work touching the same destination path, so a check-then-write
 * pair cannot interleave with another writer's.
 *
 * This closes the IN-PROCESS race only. Two separate processes still depend on
 * the processing lease, and across hosts Syncthing conflict files remain the
 * backstop — neither is something a single Node process can enforce.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function serializeByPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  // Run regardless of whether the previous write resolved or rejected.
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  writeQueues.set(path, settled);
  void settled.then(() => {
    if (writeQueues.get(path) === settled) writeQueues.delete(path);
  });
  return run;
}

export class FileSystemRepository {
  readonly root: string;
  constructor(root: string, readonly schemas = new SchemaRegistry()) { this.root = resolve(root); }

  /**
   * Set up the knowledge-base tree, once per repository instance.
   *
   * Every entry point re-enters this: processInbox and processCapture both
   * call it, so a run over N captures re-copied every bundled schema N+1
   * times — an fsync and a rename per file, per call — over a tree already
   * correct after the first. Measured on the inbox test: 5 full runs, 50
   * fsync+rename pairs, where 1 and 10 suffice.
   *
   * The repeats are not merely wasteful. Four of those five ran deep inside
   * the test body, so `schemas/` was still being rewritten late in the run —
   * and a vitest timeout does not cancel the promise chain it abandons. The
   * abandoned renames then landed inside the test's own `rm -rf`, which is how
   * `ENOTEMPTY: rmdir '.../schemas'` reached CI (fs.rm does not retry it).
   * With the memo, the only schema write happens at the caller's first
   * initialize() and is awaited before anything else runs.
   *
   * Scope is deliberately this instance and this process — a cache of work
   * already done, not a claim about the tree on disk. A rejected attempt is
   * not remembered, so a caller can retry after fixing whatever blocked it.
   */
  async initialize(): Promise<void> {
    this.initialized ??= this.runInitialize().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private initialized: Promise<void> | undefined;

  private async runInitialize(): Promise<void> {
    await Promise.all(KB_DIRECTORIES.map((directory) => mkdir(join(this.root, directory), { recursive: true })));
    for (const name of await readdir(bundledSchemaDirectory())) {
      if (!name.endsWith(".json")) continue;
      await atomicWriteFile(join(this.root, "schemas", name), await readFile(join(bundledSchemaDirectory(), name), "utf8"), { overwrite: true });
    }
  }

  async readPath(path: string): Promise<MarkdownRecord> {
    const absolute = this.resolveInside(path);
    return parseMarkdownRecord(await readFile(absolute, "utf8"), absolute);
  }

  async readById(id: string): Promise<MarkdownRecord | null> {
    for (const path of await this.listRecordPaths()) {
      // Discovery must tolerate a half-synced or malformed sibling. Callers
      // that explicitly open a path still receive its parsing error; an id
      // lookup simply keeps searching for a valid record with this id.
      const record = await this.readPath(path).catch(() => null);
      if (!record) continue;
      if (record.frontmatter.id === id) return record;
    }
    return null;
  }

  /** List candidate Markdown paths without parsing them; suitable for resilient discovery. */
  async listRecordPaths(type?: RecordType): Promise<string[]> {
    const directories = type ? [TYPE_DIRECTORIES[type]] : [...new Set(Object.values(TYPE_DIRECTORIES))];
    const paths: string[] = [];
    for (const directory of directories) paths.push(...await walkMarkdown(join(this.root, directory)));
    return paths.sort();
  }

  async listRecords(type?: RecordType): Promise<MarkdownRecord[]> {
    const directories = type ? [TYPE_DIRECTORIES[type]] : Object.values(TYPE_DIRECTORIES);
    const unique = [...new Set(directories)];
    const records: MarkdownRecord[] = [];
    for (const directory of unique) {
      for (const path of await walkMarkdown(join(this.root, directory))) records.push(await this.readPath(path));
    }
    return records;
  }

  async writeRecord(
    record: MarkdownRecord,
    options: { overwrite?: boolean; expectedContentSha256?: string; filenameHint?: string } = {},
  ): Promise<string> {
    this.schemas.validate(record.frontmatter);
    const withRevision = structuredClone(record) as MarkdownRecord;
    const priorNumber = record.frontmatter.revision?.number ?? 0;
    const priorHash = record.frontmatter.revision?.content_sha256;
    withRevision.frontmatter.revision = {
      number: priorNumber + 1,
      content_sha256: logicalRecordHash(record),
      ...(priorHash ? { previous_content_sha256: priorHash } : {}),
    };
    this.schemas.validate(withRevision.frontmatter);
    const filename = `${sanitizeFilename(options.filenameHint ?? firstHeading(record.body) ?? record.frontmatter.id)}.md`;
    const destination = join(this.root, TYPE_DIRECTORIES[record.frontmatter.type], filename);
    const content = renderMarkdownRecord(withRevision);
    // The revision check and the commit have to be ONE indivisible step. They
    // used to be separate awaits, so two writers holding the same expected
    // hash both read the old content before either renamed, both passed, and
    // the later write silently clobbered the earlier one — the optimistic
    // guard advertised by expectedContentSha256 did nothing under contention.
    return serializeByPath(destination, async () => {
      if (options.expectedContentSha256) {
        const current = await readFile(destination, "utf8").catch(() => null);
        if (current === null || sha256(current) !== options.expectedContentSha256) {
          throw new RevisionConflictError(destination);
        }
      }
      await atomicWriteFile(destination, content, {
        ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
        validate: (candidate) => {
          const parsed = parseMarkdownRecord(candidate, destination);
          this.schemas.validate(parsed.frontmatter, destination);
        },
      });
      return destination;
    });
  }

  async verifyAttachments(capture: MarkdownRecord): Promise<void> {
    if (capture.frontmatter.type !== "capture") return;
    for (const attachment of capture.frontmatter.attachments) {
      const path = this.resolveRelativeToRecord(capture, attachment.path);
      const content = await readFile(path).catch(() => null);
      if (!content) throw new Error(`${path}: attachment is missing`);
      if (sha256(content) !== attachment.sha256.toLowerCase()) throw new Error(`${path}: attachment SHA-256 mismatch`);
    }
  }

  /**
   * Remove a processor-created record only if no one changed it since the
   * processor wrote it. This is used to compensate a source-revision conflict
   * without ever deleting a subsequent human edit.
   */
  async deletePathIfUnchanged(path: string, expectedContentSha256: string): Promise<boolean> {
    const absolute = this.resolveInside(path);
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null || sha256(content) !== expectedContentSha256) return false;
    await unlink(absolute);
    return true;
  }

  resolveRelativeToRecord(record: MarkdownRecord, path: string): string {
    const base = record.sourcePath ? dirname(record.sourcePath) : this.root;
    return this.assertInside(resolve(base, path));
  }

  private resolveInside(path: string): string { return this.assertInside(resolve(this.root, path)); }
  private assertInside(path: string): string {
    // `relative` yields a leading ".." for anything outside the root, including
    // the root's own parent, so that single test covers every escape.
    if (relative(this.root, path).startsWith("..")) throw new Error(`Path escapes knowledge base: ${path}`);
    return path;
  }
}

export class RevisionConflictError extends Error {
  constructor(readonly path: string) { super(`${path}: record changed since processing began`); this.name = "RevisionConflictError"; }
}

export function sanitizeFilename(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = normalized.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return slug || "record";
}

async function walkMarkdown(directory: string): Promise<string[]> {
  try { await access(directory); } catch { return []; }
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walkMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
  }
  return paths.sort();
}
