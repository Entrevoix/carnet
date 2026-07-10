/**
 * Quiet sync indicator state for the Home header dot.
 *
 * Carnet has no sync client of its own (Syncthing watches the vault folder),
 * so "sync status" here means the enrichment queue: captures waiting for
 * OmniRoute plus captures whose enrichment failed permanently. Pure derivation
 * kept out of the React tree so the traffic-light rules are unit-testable.
 */

import { getQueueCounts } from "./queue";

export type SyncState = "idle" | "pending" | "error";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  failed: number;
  /** Plain-language one-liner for the tap-through detail dialog. */
  detail: string;
}

/** Pure rule: any permanent failure wins (needs attention), else any pending
 * row shows activity, else idle. */
export function deriveSyncStatus(pending: number, failed: number): SyncStatus {
  if (failed > 0) {
    return {
      state: "error",
      pending,
      failed,
      detail:
        `${failed} capture${failed === 1 ? "" : "s"} couldn't be enriched. ` +
        "The raw notes are safe in your vault — open one to retry, or check " +
        "the OmniRoute settings.",
    };
  }
  if (pending > 0) {
    return {
      state: "pending",
      pending,
      failed,
      detail:
        `${pending} capture${pending === 1 ? "" : "s"} waiting for enrichment. ` +
        "They'll finish automatically when OmniRoute is reachable.",
    };
  }
  return {
    state: "idle",
    pending: 0,
    failed: 0,
    detail: "All captures are written to the vault and enriched.",
  };
}

/** Read the queue and derive the indicator state. */
export async function getSyncStatus(): Promise<SyncStatus> {
  const { pending, failed } = await getQueueCounts();
  return deriveSyncStatus(pending, failed);
}
