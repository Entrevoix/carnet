/**
 * Pending-sync queue for Karakeep exports.
 *
 * When a note export fails because the HOST is unreachable (VPN/Tailscale
 * down, DNS, timeout — a status-0 network failure, never a 4xx/5xx answer),
 * the export is queued here and retried when the app foregrounds and the host
 * answers a reachability probe (lib/hostReachability.ts).
 *
 * Deliberately separate from lib/queue.ts: that queue holds RAW CAPTURES
 * waiting on OmniRoute enrichment; this one holds POINTERS to notes already
 * safe on disk, waiting on Karakeep. A pending export stores only
 * `{filepath, entryTitle}` — the note body is re-read at drain time so the
 * freshest text is exported, and a note edited (or deleted) during the queue
 * window behaves correctly for free.
 *
 * Storage mirrors queue.ts: a JSON array under one AsyncStorage key, with a
 * promise-chain lock serializing read-modify-write (no SQLite — see queue.ts's
 * header for why). Drain orchestration takes INJECTED deps so it's unit
 * testable without network or filesystem; lib/pendingSyncRunner.ts binds the
 * real ones.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

/** A queued export. `kind` is future-proofing — only Karakeep exports queue
 * today, but the drain/storage layer doesn't care what the item means. */
export interface PendingExport {
  id: string;
  kind: "karakeep-export";
  /** Vault URI of the note to export (file:// or SAF content://). */
  filepath: string;
  /** History-entry title, forwarded to the export's filename-stem fallback. */
  entryTitle: string;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
}

const PENDING_SYNC_KEY = "carnet:pendingsync:v1";

/** Attempts cap for a queued export that keeps failing with a REAL error
 * (not unreachability — those never burn attempts). Matches queue.ts's cap. */
export const MAX_PENDING_EXPORT_ATTEMPTS = 10;

// ── Storage (mirrors queue.ts) ───────────────────────────────────────────────

async function loadItems(): Promise<PendingExport[]> {
  const raw = await AsyncStorage.getItem(PENDING_SYNC_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PendingExport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveItems(items: PendingExport[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(items));
}

/** Serialize read-modify-write — an enqueue during a drain pass must not lose
 * an item. Same promise-chain lock as queue.ts. */
let _lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _lock.then(fn, fn);
  _lock = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Non-crypto row id — same rationale as queue.ts's localId (Hermes has no
 * crypto.getRandomValues without a polyfill; local uniqueness is enough). */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Strip Bearer tokens before an error string is persisted. */
function sanitizeError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [redacted]")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: [redacted]");
}

// WHAT queues: only a status-0 network failure that isn't a blank-URL
// misconfig — the "VPN/Tailscale is down" class, where no HTTP response ever
// arrived. A real status (4xx/5xx) is an ANSWER and never queues; retrying a
// not-configured error can't fix Settings, the user has to. That
// classification lives at the throw site — karakeepNoteExport's failed
// outcome carries `unreachable: boolean` (typed against KarakeepError) — so
// this module stays a pure queue with no client import.

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Queue a note for export once the host is reachable again. Deduped by
 * filepath: re-queuing an already-queued note refreshes its title (the note
 * may have been renamed) but keeps its place and attempt count — the drain
 * re-reads the body from disk anyway, so one row per note is always enough.
 */
export async function enqueuePendingExport(input: {
  filepath: string;
  entryTitle: string;
}): Promise<void> {
  await withLock(async () => {
    const items = await loadItems();
    const existing = items.findIndex((i) => i.filepath === input.filepath);
    if (existing !== -1) {
      const next = [...items];
      next[existing] = { ...next[existing], entryTitle: input.entryTitle };
      await saveItems(next);
      return;
    }
    await saveItems([
      ...items,
      {
        id: localId(),
        kind: "karakeep-export",
        filepath: input.filepath,
        entryTitle: input.entryTitle,
        queuedAt: Date.now(),
        attempts: 0,
        lastError: null,
      },
    ]);
  });
}

/** Read-only snapshot, oldest-first — feeds the Home banner + drain pass. */
export async function listPendingExports(): Promise<PendingExport[]> {
  const items = await loadItems();
  return items.map((i) => ({ ...i })).sort((a, b) => a.queuedAt - b.queuedAt);
}

/** How many exports are waiting — drives the Home banner's visibility. */
export async function getPendingExportCount(): Promise<number> {
  return (await loadItems()).length;
}

function removeItem(id: string): Promise<void> {
  return withLock(async () => {
    const items = await loadItems();
    await saveItems(items.filter((i) => i.id !== id));
  });
}

/** Bump an item's attempt count (computed inside the lock from the fresh row,
 * not the drain's snapshot); drop the item entirely once it hits the cap —
 * the note stays safe in the vault, only the auto-retry gives up. */
function bumpAttemptsOrDrop(id: string, lastError: string): Promise<void> {
  return withLock(async () => {
    const items = await loadItems();
    const i = items.findIndex((item) => item.id === id);
    if (i === -1) return;
    const attempts = items[i].attempts + 1;
    if (attempts >= MAX_PENDING_EXPORT_ATTEMPTS) {
      await saveItems(items.filter((item) => item.id !== id));
      return;
    }
    const next = [...items];
    next[i] = { ...next[i], attempts, lastError: sanitizeError(lastError) };
    await saveItems(next);
  });
}

// ── Drain ────────────────────────────────────────────────────────────────────

/** What happened to one item during a drain pass. */
export type PendingExportResult =
  /** Export landed (fully or partially — the bookmark exists either way). */
  | { kind: "ok" }
  /** The host stopped answering — end the pass, touch nothing. */
  | { kind: "unreachable" }
  /** The note no longer exists on disk — drop the item. */
  | { kind: "gone" }
  /** A real failure (the server answered with an error) — burns an attempt. */
  | { kind: "error"; message: string };

/** Injected drain dependencies — see lib/pendingSyncRunner.ts for the real
 * bindings. Injection keeps every drain branch unit-testable. */
export interface PendingSyncDrainDeps {
  /** Probe the export host. False ends the pass before any export runs. */
  isReachable: () => Promise<boolean>;
  /** Attempt one queued export and classify what happened. */
  exportOne: (item: PendingExport) => Promise<PendingExportResult>;
}

/** Single-flight guard — AppState 'active' and the Home Retry button can fire
 * near-simultaneously; a second concurrent drain would double-export. */
let _draining = false;

/**
 * Drain the pending-export queue oldest-first.
 *
 *   - Empty queue: returns without probing the host.
 *   - Host unreachable (probe, or an `unreachable` result mid-pass): stop
 *     immediately, leave every remaining item untouched — connectivity is not
 *     the items' fault, so no attempts are burned.
 *   - `ok` / `gone`: remove the item.
 *   - `error`: bump attempts (drop at {@link MAX_PENDING_EXPORT_ATTEMPTS}),
 *     keep going — one bad note must not block the rest.
 */
export async function drainPendingExports(
  deps: PendingSyncDrainDeps,
): Promise<void> {
  if (_draining) return;
  _draining = true;
  try {
    const items = await listPendingExports();
    if (items.length === 0) return;
    if (!(await deps.isReachable())) return;

    for (const item of items) {
      const result = await deps.exportOne(item);
      if (result.kind === "unreachable") return;
      if (result.kind === "ok" || result.kind === "gone") {
        await removeItem(item.id);
      } else {
        await bumpAttemptsOrDrop(item.id, result.message);
      }
    }
  } finally {
    _draining = false;
  }
}
