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
  } catch {
    const observed = await readLease(path);
    if (!observed || Date.parse(observed.expires_at) > Date.now()) {
      throw new Error(`Processing lease already held for ${resourceId}`);
    }
    // Expired leases are recoverable, but recovery must still be contended.
    // A blind `overwrite: true` let two workers that observed the SAME expired
    // lock both "acquire" it and process the capture concurrently, producing
    // conflicting derived writes; the token check on release only stops the
    // loser from deleting the winner's lock, not the duplicate work.
    // Removing the lock and then racing through the same exclusive create
    // everyone else uses makes the filesystem pick exactly one winner.
    //
    // Residual: a worker descheduled between the read above and this unlink
    // can still drop a lease acquired in the interim. Closing that needs a
    // conditional-remove primitive the filesystem does not offer.
    await unlink(path).catch(() => undefined);
    try {
      await atomicWriteFile(path, JSON.stringify(lease), { overwrite: false });
    } catch {
      throw new Error(`Processing lease already held for ${resourceId}`);
    }
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
