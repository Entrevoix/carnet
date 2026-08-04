import { createHash } from "node:crypto";

export function idempotencyKey(
  processorName: string,
  processorVersion: string,
  sourceId: string,
  sourceRevision: string,
): string {
  return createHash("sha256")
    .update([processorName, processorVersion, sourceId, sourceRevision].join("\0"))
    .digest("hex");
}
