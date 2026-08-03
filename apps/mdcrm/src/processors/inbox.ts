import type { MdcrmConfig } from "../config/config.js";
import { NOOP_LOGGER, type Logger } from "../logging/logger.js";
import type { CaptureRecord, MarkdownRecord } from "../models/records.js";
import { FileSystemRepository } from "../storage/repository.js";
import { processCapture, type ProcessResult } from "./capturePipeline.js";

export interface InboxProcessResult {
  discovered: number;
  processed: Array<{ captureId: string; result: ProcessResult }>;
  failed: Array<{ captureId?: string; path: string; error: string }>;
}

/**
 * Process every capture visible through the filesystem adapter. It is safe for
 * cron, a systemd timer, or a sync hook: each per-capture run is idempotent,
 * and one malformed package does not block later captures.
 */
export async function processInbox(
  repository: FileSystemRepository,
  config: MdcrmConfig,
  logger: Logger = NOOP_LOGGER,
): Promise<InboxProcessResult> {
  await repository.initialize();
  const paths = await repository.listRecordPaths("capture");
  const result: InboxProcessResult = { discovered: paths.length, processed: [], failed: [] };
  const captures: MarkdownRecord<CaptureRecord>[] = [];

  for (const path of paths) {
    try {
      const record = await repository.readPath(path);
      if (record.frontmatter.type !== "capture") throw new Error("record type is not capture");
      captures.push(record as MarkdownRecord<CaptureRecord>);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log({ level: "error", processor: "inbox", processor_version: "1.0.0", stage: "discover", message });
      result.failed.push({ path, error: message });
    }
  }

  captures.sort((left, right) => left.frontmatter.created_at.localeCompare(right.frontmatter.created_at));

  for (const capture of captures) {
    try {
      result.processed.push({
        captureId: capture.frontmatter.id,
        result: await processCapture(repository, config, capture.frontmatter.id, logger),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log({
        level: "error", processor: "inbox", processor_version: "1.0.0",
        capture_id: capture.frontmatter.id, stage: "process", message,
      });
      result.failed.push({ captureId: capture.frontmatter.id, path: capture.sourcePath ?? capture.frontmatter.id, error: message });
    }
  }
  return result;
}
