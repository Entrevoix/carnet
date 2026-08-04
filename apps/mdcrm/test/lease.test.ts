import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireLease } from "../src/storage/lease.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mdcrm-lease-"));
  roots.push(root);
  // acquireLease creates this lazily via atomicWriteFile, but the tests that
  // seed a pre-existing lock write to it directly.
  await mkdir(join(root, "processing", "locks"), { recursive: true });
  return root;
}

function lockPath(root: string, resourceId: string): string {
  return join(root, "processing", "locks", `${resourceId}.lock`);
}

async function writeLease(
  root: string,
  resourceId: string,
  overrides: { token?: string; expiresAt?: string } = {},
): Promise<void> {
  const lease = {
    token: overrides.token ?? "pre-existing-token",
    owner: "999",
    acquired_at: new Date(0).toISOString(),
    expires_at: overrides.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
  };
  await writeFile(lockPath(root, resourceId), JSON.stringify(lease), "utf8");
}

describe("processing lease", () => {
  it("acquires a lease when the lock is free", async () => {
    const root = await harness();
    const lease = await acquireLease(root, "cap_free", 300);
    expect(lease.token).toMatch(/^[0-9a-f-]{36}$/);
    await expect(readFile(lockPath(root, "cap_free"), "utf8")).resolves.toContain(lease.token);
  });

  it("refuses when a live lease is already held", async () => {
    const root = await harness();
    await writeLease(root, "cap_busy");
    await expect(acquireLease(root, "cap_busy", 300)).rejects.toThrow("lease already held");
  });

  it("takes over a lease that has expired", async () => {
    const root = await harness();
    await writeLease(root, "cap_stale", { expiresAt: new Date(Date.now() - 1_000).toISOString() });

    const lease = await acquireLease(root, "cap_stale", 300);
    await expect(readFile(lockPath(root, "cap_stale"), "utf8")).resolves.toContain(lease.token);
  });

  it("lets only ONE worker take over the same expired lease", async () => {
    const root = await harness();
    await writeLease(root, "cap_race", { expiresAt: new Date(Date.now() - 1_000).toISOString() });

    // Both workers observe the same expired lock. A blind overwrite lets both
    // succeed and process the capture concurrently, producing conflicting
    // derived writes; the takeover has to be a contended exclusive create.
    const results = await Promise.allSettled([
      acquireLease(root, "cap_race", 300, "worker-a"),
      acquireLease(root, "cap_race", 300, "worker-b"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("release removes only the caller's own lease", async () => {
    const root = await harness();
    const lease = await acquireLease(root, "cap_own", 300);
    // A later owner replaced the lock; the earlier worker must not delete it.
    await writeLease(root, "cap_own", { token: "someone-elses" });

    await lease.release();

    await expect(readFile(lockPath(root, "cap_own"), "utf8")).resolves.toContain("someone-elses");
  });

  it("rejects a resource id that could escape the locks directory", async () => {
    const root = await harness();
    await expect(acquireLease(root, "../../etc/passwd", 300)).rejects.toThrow("Unsafe lease resource id");
  });
});
