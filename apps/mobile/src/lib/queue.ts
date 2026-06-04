/**
 * Offline capture queue for carnet v0.2.
 *
 * When OmniRoute is unreachable (network error or 5xx), a capture is stored
 * in a local SQLite database. On reconnect or app foreground, a drain loop
 * processes the queue oldest-first:
 *   - Success → write file to disk + remove row
 *   - 4xx (permanent failure) → mark as failed, stop auto-retrying
 *   - Network error / 5xx → leave in queue, retry next drain
 *
 * The API key is NOT stored in the queue — it is read fresh from SecureStore
 * on each drain pass. Only the raw user input is persisted.
 *
 * Note: background execution on Android is limited. If the app is fully killed,
 * draining happens on next foreground open — not a regression vs. navetted.
 */

import * as SQLite from "expo-sqlite";
import * as Haptics from "expo-haptics";

import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  isPermanentError,
} from "./omniroute";
import { writeIdea, appendJournal, writePerson, slugify } from "./writer";
import { deriveTitle } from "@carnet/shared";

export type CaptureMode = "idea" | "journal" | "person";

/** Strip Bearer tokens from any error string before it's persisted or shown. */
function sanitizeError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

/** Raw user input stored in the queue — no credentials. */
export interface IdeaPayload {
  mode: "idea";
  text: string;
}

export interface JournalPayload {
  mode: "journal";
  transcript: string;
  notes: string;
  date: string;
}

export interface PersonPayload {
  mode: "person";
  ocrResult: string;
  context: string;
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

const DB_NAME = "carnet_queue.db";
const MAX_AUTO_RETRY_ATTEMPTS = 10;
/** Sentinel attempts value meaning "permanent failure — do not auto-retry".
 * Set when OmniRoute returns a 4xx (auth, bad model, malformed input). */
const PERMANENT_FAILURE_ATTEMPTS = MAX_AUTO_RETRY_ATTEMPTS;

let _db: SQLite.SQLiteDatabase | null = null;
/** Single-flight guard. CaptureScreen mounts re-trigger drainQueue and a
 * connectivity event could fire in parallel. Without this, two drains read
 * the same rows and both try to write — double-write to disk + double-charge
 * OmniRoute. */
let _draining = false;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS pending_captures (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  return _db;
}

/** Returns the current depth of the pending queue (excluding permanently failed). */
export async function getQueueDepth(): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM pending_captures WHERE attempts < ?",
    MAX_AUTO_RETRY_ATTEMPTS,
  );
  return rows[0]?.count ?? 0;
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
  const db = await getDb();
  const id = localId();
  const now = Date.now();
  await db.runAsync(
    "INSERT INTO pending_captures (id, mode, payload_json, created_at, attempts, last_error) VALUES (?, ?, ?, ?, 0, NULL)",
    id,
    payload.mode,
    JSON.stringify(payload),
    now,
  );
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
    const db = await getDb();
    const rows = await db.getAllAsync<QueueRow>(
      "SELECT * FROM pending_captures WHERE attempts < ? ORDER BY created_at ASC",
      MAX_AUTO_RETRY_ATTEMPTS,
    );

    for (const row of rows) {
      let payload: QueuePayload;
      try {
        payload = JSON.parse(row.payload_json) as QueuePayload;
      } catch {
        // Corrupt row — remove it
        await db.runAsync("DELETE FROM pending_captures WHERE id = ?", row.id);
        continue;
      }

      try {
        await processRow(payload);
        // Success: remove from queue
        await db.runAsync("DELETE FROM pending_captures WHERE id = ?", row.id);
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e);
        const msg = sanitizeError(raw);
        // 4xx → mark as permanent failure immediately. Retrying a 401 ten
        // times in seconds doesn't help — the user needs to fix the cause.
        const newAttempts = isPermanentError(e)
          ? PERMANENT_FAILURE_ATTEMPTS
          : row.attempts + 1;
        await db.runAsync(
          "UPDATE pending_captures SET attempts = ?, last_error = ? WHERE id = ?",
          newAttempts,
          msg,
          row.id,
        );
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
    await writeIdea(slug, result.markdown);
  } else if (payload.mode === "journal") {
    const result = await enrichJournal({
      transcript: payload.transcript,
      notes: payload.notes,
    });
    await appendJournal(payload.date, result.markdown);
  } else if (payload.mode === "person") {
    const result = await enrichPerson({
      ocrResult: payload.ocrResult,
      context: payload.context,
    });
    // Extract name — pass empty strings to writePerson so it falls back to markdown
    await writePerson("", "", result.markdown);
  }
}

/**
 * Returns all rows including permanently-failed ones (for debugging / admin).
 */
export async function getAllQueueRows(): Promise<QueueRow[]> {
  const db = await getDb();
  return db.getAllAsync<QueueRow>(
    "SELECT * FROM pending_captures ORDER BY created_at ASC",
  );
}

/**
 * Clear all permanently-failed rows (attempts >= MAX_AUTO_RETRY_ATTEMPTS).
 */
export async function clearFailedRows(): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM pending_captures WHERE attempts >= ?",
    MAX_AUTO_RETRY_ATTEMPTS,
  );
}
