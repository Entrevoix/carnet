import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bundledSchemaDirectory } from "../src/schemas/registry.js";
import { FileSystemRepository } from "../src/storage/repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mdcrm-repo-"));
  roots.push(root);
  return root;
}

async function schemaInodes(root: string): Promise<Map<string, number>> {
  const entries = await readdir(join(root, "schemas"));
  const inodes = new Map<string, number>();
  for (const name of entries.sort()) inodes.set(name, (await stat(join(root, "schemas", name))).ino);
  return inodes;
}

describe("FileSystemRepository.initialize", () => {
  it("creates the knowledge-base tree and copies the bundled schemas", async () => {
    const root = await freshRoot();
    await new FileSystemRepository(root).initialize();

    const bundled = (await readdir(bundledSchemaDirectory())).filter((name) => name.endsWith(".json")).sort();
    expect(bundled.length).toBeGreaterThan(0);
    expect((await readdir(join(root, "schemas"))).sort()).toEqual(bundled);
    expect((await stat(join(root, "inbox", "pending"))).isDirectory()).toBe(true);
  });

  // Every processInbox/processCapture call re-entered initialize(), which
  // re-copied all bundled schemas through atomicWriteFile — an fsync plus a
  // rename per file, per call. A two-capture processInbox run did it seven
  // times over. That made the inbox suite disk-bound enough to approach
  // vitest's 5s default on a loaded CI runner, and because a timed-out test's
  // promise chain keeps running, those renames landed inside the afterEach
  // rm(), which surfaced as `ENOTEMPTY: rmdir '.../schemas'` (fs.rm does not
  // retry ENOTEMPTY). Inodes, not mtimes: the copy renames a temp file into
  // place, so a rewrite always replaces the inode regardless of clock
  // granularity or identical content.
  it("does not redo the schema copy on repeated calls to the same repository", async () => {
    const root = await freshRoot();
    const repository = new FileSystemRepository(root);
    await repository.initialize();
    const before = await schemaInodes(root);

    await repository.initialize();
    await repository.initialize();

    expect(await schemaInodes(root)).toEqual(before);
  });

  it("shares one in-flight initialization between concurrent callers", async () => {
    const root = await freshRoot();
    const repository = new FileSystemRepository(root);

    await Promise.all([repository.initialize(), repository.initialize(), repository.initialize()]);
    const before = await schemaInodes(root);
    await repository.initialize();

    expect(await schemaInodes(root)).toEqual(before);
  });

  // The memo is per instance, deliberately: it is a within-process cache of
  // work already done, not a claim about the tree on disk. A caller that wants
  // the bundled schemas re-applied (an upgrade re-running `mdcrm init`) gets a
  // new process, and therefore a new repository, either way.
  it("re-applies the bundled schemas for a new repository over the same root", async () => {
    const root = await freshRoot();
    await new FileSystemRepository(root).initialize();
    const before = await schemaInodes(root);

    await new FileSystemRepository(root).initialize();

    const after = await schemaInodes(root);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect([...after.values()]).not.toEqual([...before.values()]);
  });

  // A failed initialization must not be remembered as done, or every later
  // caller in the process would silently skip setup against an unusable tree.
  it("retries after a failed initialization instead of caching the failure", async () => {
    const root = await freshRoot();
    // A plain file where the tree needs a directory: mkdir fails with ENOTDIR.
    const blockingFile = join(root, "blocked");
    await writeFile(blockingFile, "not a directory", "utf8");
    const repository = new FileSystemRepository(blockingFile);

    await expect(repository.initialize()).rejects.toThrow();
    // Unblock, then re-initialize: a cached rejection (or a memo that recorded
    // the attempt as done) would make this throw again or leave no schemas.
    await rm(blockingFile);
    await repository.initialize();

    expect((await readdir(join(blockingFile, "schemas"))).length).toBeGreaterThan(0);
  });
});
