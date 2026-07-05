/**
 * Offline capture queue for carnet v0.2.
 *
 * When OmniRoute is unreachable (network error or 5xx), a capture is stored
 * in AsyncStorage (a JSON array under a single key). On reconnect or app
 * foreground, a drain loop processes the queue oldest-first:
 *   - Success → write file to disk + remove row
 *   - 4xx (permanent failure) → mark as failed, stop auto-retrying
 *   - Network error / 5xx → leave in queue, retry next drain
 *
 * The API key is NOT stored in the queue — it is read fresh from SecureStore
 * on each drain pass. Only the raw user input is persisted.
 *
 * Storage note: this used expo-sqlite, but that native module throws a SharedRef
 * ABI error on-device (expo-sqlite@55 against the SDK-54 expo-modules-core), so
 * the queue never persisted. AsyncStorage's native module is already present and
 * working (see storage.ts), needs no native rebuild, and the queue only holds a
 * handful of small text rows — SQLite was overkill.
 *
 * Note: background execution on Android is limited. If the app is fully killed,
 * draining happens on next foreground open — not a regression vs. navetted.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  isPermanentError,
  isNotConfiguredError,
} from "./omniroute";
import {
  writeIdea,
  appendJournal,
  writePerson,
  slugify,
  injectAttachments,
  type AttachmentRef,
} from "./writer";
import { mergeUserTags } from "./tags";
import { upsertFrontmatterField } from "./frontmatter";
import { invalidateNoteIndex } from "./vault";
import { deriveTitle } from "@carnet/shared";

/** Inject a `location: lat,lon` frontmatter field, or a no-op when unset. */
function injectLocation(markdown: string, location?: string): string {
  return location ? upsertFrontmatterField(markdown, "location", location) : markdown;
}

export type CaptureMode = "idea" | "journal" | "person";

/** Strip Bearer tokens from any error string before it's persisted or shown. */
function sanitizeError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/** Raw user input stored in the queue — no credentials. Attachments carry only
 * their `../{subdir}/{name}` rel-paths: the binaries are written to disk before
 * enqueue (local + offline-safe), so the queue stays small and never holds
 * base64 — same rule as "the API key is read fresh, never queued". */
export interface IdeaPayload {
  mode: "idea";
  text: string;
  attachments?: AttachmentRef[];
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
}

export interface JournalPayload {
  mode: "journal";
  transcript: string;
  notes: string;
  date: string;
  attachments?: AttachmentRef[];
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
}

export interface PersonPayload {
  mode: "person";
  ocrResult: string;
  context: string;
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
}

export type QueuePayload = IdeaPayload | JournalPayload | PersonPayload;

export interface QueueRow {
  id: string;
  mode: CaptureMode;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

const QUEUE_KEY = "carnet:queue:v1";
const MAX_AUTO_RETRY_ATTEMPTS = 10;
/** Sentinel attempts value meaning "permanent failure — do not auto-retry".
 * Set when OmniRoute returns a 4xx (auth, bad model, malformed input). */
const PERMANENT_FAILURE_ATTEMPTS = MAX_AUTO_RETRY_ATTEMPTS;

/** Single-flight guard. CaptureScreen mounts re-trigger drainQueue and a
 * connectivity event could fire in parallel. Without this, two drains read
 * the same rows and both try to write — double-write to disk + double-charge
 * OmniRoute. */
let _draining = false;

// ── AsyncStorage-backed storage ──────────────────────────────────────────
// The queue is a JSON array of QueueRow under QUEUE_KEY. Mirrors storage.ts's
// recents-history persistence.

async function loadRows(): Promise<QueueRow[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueueRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRows(rows: QueueRow[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(rows));
}

/** Serialize read-modify-write so a concurrent enqueue during a drain pass
 * (CaptureScreen mount drains while a new failed capture enqueues) can't lose a
 * row. SQLite gave per-statement atomicity for free; AsyncStorage RMW does not. */
let _lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _lock.then(fn, fn);
  _lock = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Remove a row by id (locked read-modify-write). */
function removeRow(id: string): Promise<void> {
  return withLock(async () => {
    const rows = await loadRows();
    await saveRows(rows.filter((r) => r.id !== id));
  });
}

/** Bump a row's attempt count + last_error by id (locked read-modify-write).
 * Computes the next attempts value from the freshly-loaded row (not a stale
 * drain snapshot), collapsing a permanent (4xx) failure to the sentinel. */
function bumpAttempts(
  id: string,
  permanent: boolean,
  last_error: string,
): Promise<void> {
  return withLock(async () => {
    const rows = await loadRows();
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) return;
    const attempts = permanent
      ? PERMANENT_FAILURE_ATTEMPTS
      : rows[i].attempts + 1;
    rows[i] = { ...rows[i], attempts, last_error };
    await saveRows(rows);
  });
}

/** Returns the current depth of the pending queue (excluding permanently failed). */
export async function getQueueDepth(): Promise<number> {
  const rows = await loadRows();
  return rows.filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS).length;
}

/** Non-crypto, unique-enough row id. uuid v11 needs crypto.getRandomValues,
 * which RN/Hermes lacks without the (uninstalled) react-native-get-random-values
 * polyfill — calling it here threw and left offline captures stuck on the
 * spinner. A queue-row id only needs local uniqueness, so timestamp + random
 * base36 is plenty. Mirrors CaptureScreen's localId. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Enqueue a failed capture for later retry. */
export async function enqueue(payload: QueuePayload): Promise<void> {
  await withLock(async () => {
    const rows = await loadRows();
    rows.push({
      id: localId(),
      mode: payload.mode,
      payload_json: JSON.stringify(payload),
      created_at: Date.now(),
      attempts: 0,
      last_error: null,
    });
    await saveRows(rows);
  });
  // Light haptic so the user feels the offline queue accept the capture.
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/**
 * Drain the queue: process all pending captures oldest-first.
 * Resolves when the drain pass is complete (or queue is empty).
 * Each successful item writes its file and removes the row.
 *
 * Single-flight: parallel callers are a no-op once one drain is in flight.
 * Errors are classified — 4xx from OmniRoute marks the row as permanent
 * failure (won't auto-retry), network/5xx increments attempts normally.
 */
export async function drainQueue(): Promise<void> {
  if (_draining) return;
  _draining = true;
  try {
    const rows = (await loadRows())
      .filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS)
      .sort((a, b) => a.created_at - b.created_at);

    for (const row of rows) {
      let payload: QueuePayload;
      try {
        payload = JSON.parse(row.payload_json) as QueuePayload;
      } catch {
        // Corrupt row — remove it
        await removeRow(row.id);
        continue;
      }

      try {
        await processRow(payload);
        // Success: remove from queue
        await removeRow(row.id);
      } catch (e: unknown) {
        // Blank OmniRoute URL: every remaining row would fail identically.
        // Stop the pass and leave all rows intact — do NOT burn retry attempts
        // (which would eventually mark genuine captures permanently failed).
        // They'll drain on the next open once the user sets a URL.
        if (isNotConfiguredError(e)) break;
        const raw = e instanceof Error ? e.message : String(e);
        const msg = sanitizeError(raw);
        // 4xx → mark as permanent failure immediately. Retrying a 401 ten
        // times in seconds doesn't help — the user needs to fix the cause.
        // The attempts increment is computed inside the lock from the current
        // row, not this drain's snapshot.
        await bumpAttempts(row.id, isPermanentError(e), msg);
      }
    }
  } finally {
    _draining = false;
  }
}

/** Process a single queued payload: enrich + write to disk. */
async function processRow(payload: QueuePayload): Promise<void> {
  if (payload.mode === "idea") {
    const result = await enrichIdea(payload.text);
    const title = deriveTitle(result.markdown);
    const slug = slugify(title) || "untitled";
    // Binaries were already written to disk at enqueue; fold their rel-paths
    // back into the body so the drained note matches the online capture.
    // Tags are merged AFTER attachments so the frontmatter merge sees the final body.
    const md = injectLocation(
      mergeUserTags(injectAttachments(result.markdown, payload.attachments ?? []), payload.tags),
      payload.location,
    );
    await writeIdea(slug, md);
  } else if (payload.mode === "journal") {
    const result = await enrichJournal({
      transcript: payload.transcript,
      notes: payload.notes,
    });
    const md = injectLocation(
      mergeUserTags(injectAttachments(result.markdown, payload.attachments ?? []), payload.tags),
      payload.location,
    );
    await appendJournal(payload.date, md);
  } else if (payload.mode === "person") {
    const result = await enrichPerson({
      ocrResult: payload.ocrResult,
      context: payload.context,
    });
    // Extract name — pass empty strings to writePerson so it falls back to markdown
    await writePerson(
      "",
      "",
      injectLocation(mergeUserTags(result.markdown, payload.tags), payload.location),
    );
  }
  // A drained capture adds tags to the vault — drop the stale index cache so the
  // browser + autocomplete rebuild. Best-effort; never fail the drain on this.
  void invalidateNoteIndex().catch(() => undefined);
}

/**
 * Returns all rows including permanently-failed ones (for debugging / admin).
 */
export async function getAllQueueRows(): Promise<QueueRow[]> {
  const rows = await loadRows();
  return [...rows].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Clear all permanently-failed rows (attempts >= MAX_AUTO_RETRY_ATTEMPTS).
 */
export async function clearFailedRows(): Promise<void> {
  await withLock(async () => {
    const rows = await loadRows();
    await saveRows(rows.filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS));
  });
}
