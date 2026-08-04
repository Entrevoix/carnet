import type { CaptureRecord, ContactRecord } from "../models/records.js";
import { normalizeEmail, normalizeName, normalizeOrganization, normalizePhone } from "../normalization/values.js";

export interface MatchWeights {
  exactEmail: number; exactPhone: number; exactProfileUrl: number; exactName: number;
  fuzzyName: number; exactOrganization: number; sameEmailDomain: number;
  similarTitle: number; sameEvent: number; conflictingEmail: number;
  conflictingPhone: number; conflictingCompanyWeakName: number;
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  exactEmail: 100, exactPhone: 90, exactProfileUrl: 100, exactName: 40,
  fuzzyName: 25, exactOrganization: 25, sameEmailDomain: 15, similarTitle: 10,
  sameEvent: 10, conflictingEmail: -60, conflictingPhone: -50, conflictingCompanyWeakName: -20,
};

/**
 * Machine-readable match signals. Callers branch on these; `evidence` is
 * display text and rewording it must never change a downstream decision.
 */
export type MatchReason =
  | "exact_email" | "conflicting_email"
  | "exact_phone" | "conflicting_phone"
  | "exact_name" | "fuzzy_name"
  | "exact_organization" | "conflicting_organization_weak_name"
  | "same_email_domain" | "similar_title" | "same_event";

export interface MatchCandidate { contact: ContactRecord; score: number; evidence: string[]; reasons: MatchReason[] }

export function scoreContact(
  capture: CaptureRecord,
  contact: ContactRecord,
  options: { eventContactIds?: readonly string[]; weights?: MatchWeights } = {},
): MatchCandidate {
  const weights = options.weights ?? DEFAULT_MATCH_WEIGHTS;
  const extracted = capture.extracted ?? {};
  const email = normalizeEmail(extracted.email ?? "");
  const phone = extracted.phone_normalized || normalizePhone(extracted.phone_display ?? "");
  const name = normalizeName(extracted.name ?? "");
  const organization = normalizeOrganization(extracted.company ?? "");
  const contactEmails = contact.emails.map((item) => item.normalized);
  const contactPhones = contact.phones.map((item) => item.normalized);
  let score = 0;
  const evidence: string[] = [];
  const reasons: MatchReason[] = [];

  if (email && contactEmails.includes(email)) add(weights.exactEmail, "exact normalized email", "exact_email");
  else if (email && contactEmails.length > 0) add(weights.conflictingEmail, "conflicting email", "conflicting_email");
  if (phone && contactPhones.includes(phone)) add(weights.exactPhone, "exact normalized phone", "exact_phone");
  else if (phone && contactPhones.length > 0) add(weights.conflictingPhone, "conflicting phone", "conflicting_phone");

  if (name && name === contact.name.normalized) add(weights.exactName, "exact normalized name", "exact_name");
  else if (name && similarity(name, contact.name.normalized) >= 0.85) add(weights.fuzzyName, "strong fuzzy name", "fuzzy_name");

  const contactOrganization = normalizeOrganization(contact.organization?.name ?? "");
  if (organization && organization === contactOrganization) add(weights.exactOrganization, "exact normalized organization", "exact_organization");
  else if (organization && contactOrganization && (!name || similarity(name, contact.name.normalized) < 0.85)) {
    add(weights.conflictingCompanyWeakName, "conflicting organization with weak name", "conflicting_organization_weak_name");
  }

  const domain = email.split("@")[1];
  if (domain && contactEmails.some((candidate) => candidate.endsWith(`@${domain}`))) add(weights.sameEmailDomain, "same email domain", "same_email_domain");
  if (extracted.title && contact.title && similarity(normalizeName(extracted.title), normalizeName(contact.title)) >= 0.8) add(weights.similarTitle, "similar title", "similar_title");
  if (options.eventContactIds?.includes(contact.id)) add(weights.sameEvent, "same event", "same_event");

  return { contact, score, evidence, reasons };

  function add(points: number, reason: string, code: MatchReason): void {
    score += points;
    evidence.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
    reasons.push(code);
  }
}

export function rankContactCandidates(capture: CaptureRecord, contacts: readonly ContactRecord[]): MatchCandidate[] {
  return contacts.map((contact) => scoreContact(capture, contact)).filter((candidate) => candidate.score !== 0).sort((a, b) => b.score - a.score || a.contact.id.localeCompare(b.contact.id));
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? j;
      const current = a[i - 1] === b[j - 1] ? diagonal : Math.min(diagonal, above, previous[j - 1] ?? i) + 1;
      diagonal = above;
      previous[j] = current;
    }
  }
  return 1 - (previous[b.length] ?? Math.max(a.length, b.length)) / Math.max(a.length, b.length);
}
