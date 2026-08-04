import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteFile } from "./atomic.js";

interface LeaseFile { token: string; owner: string; acquired_at: string; expires_at: string }

export interface Lease { token: string; release: () => Promise<void> }

export async function acquireLease(
  root: string,
  resourceId: string,
  durationSeconds: number,
  owner = `${process.pid}`,
): Promise<Lease> {
  const path = join(root, "processing", "locks", `${safeResource(resourceId)}.lock`);
  const token = randomUUID();
  const now = new Date();
  const lease: LeaseFile = {
    token, owner, acquired_at: now.toISOString(),
    expires_at: new Date(now.getTime() + durationSeconds * 1000).toISOString(),
  };
  try {
    await atomicWriteFile(path, JSON.stringify(lease), { overwrite: false });
  } catch (error: unknown) {
    const existing = await readLease(path);
    if (!existing || Date.parse(existing.expires_at) > Date.now()) {
      throw new Error(`Processing lease already held for ${resourceId}`);
    }
    // Expired leases are recoverable. Replacement is atomic; the token check
    // on release prevents an old worker from deleting the new owner's lease.
    await atomicWriteFile(path, JSON.stringify(lease), { overwrite: true });
  }
  return {
    token,
    release: async () => {
      const current = await readLease(path);
      if (current?.token === token) await unlink(path).catch(() => undefined);
    },
  };
}

async function readLease(path: string): Promise<LeaseFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Partial<LeaseFile>;
    return typeof value.token === "string" && typeof value.expires_at === "string" ? value as LeaseFile : null;
  } catch { return null; }
}

function safeResource(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Unsafe lease resource id: ${value}`);
  return value;
}
