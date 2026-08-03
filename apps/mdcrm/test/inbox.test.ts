import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/config.js";
import { createId } from "../src/models/ids.js";
import type { CaptureRecord } from "../src/models/records.js";
import { processInbox } from "../src/processors/inbox.js";
import { FileSystemRepository } from "../src/storage/repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(): Promise<FileSystemRepository> {
  const root = await mkdtemp(join(tmpdir(), "mdcrm-inbox-"));
  roots.push(root);
  const repository = new FileSystemRepository(root);
  await repository.initialize();
  return repository;
}

function capture(id = createId("capture")): CaptureRecord {
  return {
    schema_version: 1, type: "capture", id, created_at: "2026-08-03T09:22:00.000Z", updated_at: "2026-08-03T09:22:00.000Z",
    captured_by: "test-device", capture_method: "camera", capture_kind: "business_card", processing_status: "captured",
    review_status: "unreviewed", attachments: [], extracted: { name: "Jane Smith", email: "jane@acme.example" },
  };
}

describe("filesystem inbox processor", () => {
  it("processes every independent capture and continues after a malformed attachment", async () => {
    const repository = await setup();
    const valid = capture();
    const invalid = capture();
    invalid.attachments = [{ id: createId("attachment"), role: "original", path: "../attachments/originals/missing.jpg", media_type: "image/jpeg", sha256: "0".repeat(64) }];
    await repository.writeRecord({ frontmatter: valid, body: "# Valid\n" }, { filenameHint: valid.id });
    await repository.writeRecord({ frontmatter: invalid, body: "# Invalid\n" }, { filenameHint: invalid.id });

    const config = { ...structuredClone(DEFAULT_CONFIG), knowledgeBasePath: repository.root };
    const first = await processInbox(repository, config);
    expect(first.discovered).toBe(2);
    expect(first.processed).toHaveLength(1);
    expect(first.failed).toEqual([expect.objectContaining({ captureId: invalid.id, error: expect.stringContaining("attachment is missing") })]);
    expect((await repository.listRecords("contact"))).toHaveLength(1);

    const second = await processInbox(repository, config);
    expect(second.processed[0]?.result.reused).toBe(true);
    expect((await repository.listRecords("contact"))).toHaveLength(1);
  });

  it("reports malformed YAML but still processes later valid captures", async () => {
    const repository = await setup();
    const valid = capture();
    await writeFile(join(repository.root, "captures", "partial-sync.md"), "---\nid: [\n---\n# Partial\n", "utf8");
    await repository.writeRecord({ frontmatter: valid, body: "# Valid\n" }, { filenameHint: valid.id });

    const result = await processInbox(repository, { ...structuredClone(DEFAULT_CONFIG), knowledgeBasePath: repository.root });
    expect(result.discovered).toBe(2);
    expect(result.processed.map((entry) => entry.captureId)).toEqual([valid.id]);
    expect(result.failed).toEqual([expect.objectContaining({ path: expect.stringContaining("partial-sync.md"), error: expect.stringContaining("invalid YAML") })]);
    expect((await repository.listRecords("contact"))).toHaveLength(1);
  });
});
