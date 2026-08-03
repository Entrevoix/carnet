import { monotonicFactory } from "ulid";

const nextUlid = monotonicFactory();

export const ID_PREFIXES = {
  capture: "cap_",
  contact: "con_",
  organization: "org_",
  event: "evt_",
  interaction: "int_",
  task: "tsk_",
  attachment: "att_",
  processing_job: "job_",
  review_item: "rev_",
  proposed_change: "chg_",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function createId(kind: IdKind, timestamp?: number): string {
  return `${ID_PREFIXES[kind]}${nextUlid(timestamp)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${ID_PREFIXES[kind]}[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}
