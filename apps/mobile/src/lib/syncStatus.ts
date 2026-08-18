/**
 * Quiet sync indicator state for the Home header dot.
 *
 * Carnet has no sync client of its own (Syncthing watches the vault folder),
 * so "sync status" here means the enrichment queue: captures waiting for the
 * active LLM provider plus captures whose enrichment failed permanently.
 * `deriveSyncStatus` is a pure derivation kept out of the React tree so the
 * traffic-light rules are unit-testable, taking the active provider's label
 * as a parameter rather than reading Settings itself; `getSyncStatus`
 * resolves that label via Settings + llmProviders.ts's resolveActiveProvider
 * before calling it.
 */

import { getQueueCounts } from "./queue";
import { getSettings } from "./settings";
import { resolveActiveProvider, UNKNOWN_PROVIDER_LABEL } from "./llmProviders";

export type SyncState = "idle" | "pending" | "error";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  failed: number;
  /** Plain-language one-liner for the tap-through detail dialog. */
  detail: string;
}

/** Pure rule: any permanent failure wins (needs attention), else any pending
 * row shows activity, else idle. `providerLabel` names the active provider in
 * the pending/error copy; defaults to a provider-neutral phrasing when the
 * caller has none to hand. */
export function deriveSyncStatus(
  pending: number,
  failed: number,
  providerLabel: string = UNKNOWN_PROVIDER_LABEL,
): SyncStatus {
  if (failed > 0) {
    return {
      state: "error",
      pending,
      failed,
      detail:
        `${failed} capture${failed === 1 ? "" : "s"} couldn't be enriched. ` +
        "The raw notes are safe in your vault — open one to retry, or check " +
        `the ${providerLabel} settings.`,
    };
  }
  if (pending > 0) {
    return {
      state: "pending",
      pending,
      failed,
      detail:
        `${pending} capture${pending === 1 ? "" : "s"} waiting for enrichment. ` +
        `They'll finish automatically when ${providerLabel} is reachable.`,
    };
  }
  return {
    state: "idle",
    pending: 0,
    failed: 0,
    detail: "All captures are written to the vault and enriched.",
  };
}

/** Read the queue and settings, and derive the indicator state naming the
 * active provider. */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [{ pending, failed }, settings] = await Promise.all([
    getQueueCounts(),
    getSettings(),
  ]);
  const providerLabel = resolveActiveProvider(
    settings.llmProviders,
    settings.activeProviderId,
  ).label;
  return deriveSyncStatus(pending, failed, providerLabel);
}
