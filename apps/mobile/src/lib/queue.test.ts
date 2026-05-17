import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory SQLite mock ─────────────────────────────────────────────────────

interface Row {
  id: string;
  mode: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

// Simple in-memory store keyed by id
const _rows: Map<string, Row> = new Map();

const mockDb = {
  execAsync: vi.fn(async (_sql: string) => {}),
  getAllAsync: vi.fn(async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
    let rows = Array.from(_rows.values());
    // Filter by attempts < MAX if the query mentions it
    if (sql.includes("attempts <") && params.length > 0) {
      const limit = params[0] as number;
      rows = rows.filter((r) => r.attempts < limit);
    }
    // Sort by created_at
    rows.sort((a, b) => a.created_at - b.created_at);
    // COUNT query
    if (sql.includes("COUNT(*)")) {
      return [{ count: rows.length }];
    }
    return rows;
  }),
  runAsync: vi.fn(async (sql: string, ...params: unknown[]) => {
    if (sql.startsWith("INSERT")) {
      const [id, mode, payload_json, created_at] = params as [string, string, string, number];
      _rows.set(id, { id, mode, payload_json, created_at, attempts: 0, last_error: null });
    } else if (sql.startsWith("DELETE")) {
      const id = params[0] as string;
      _rows.delete(id);
    } else if (sql.startsWith("UPDATE")) {
      // UPDATE pending_captures SET attempts = ?, last_error = ? WHERE id = ?
      const [attempts, last_error, id] = params as [number, string, string];
      const row = _rows.get(id);
      if (row) {
        _rows.set(id, { ...row, attempts, last_error });
      }
    }
  }),
};

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(async (_name: string) => mockDb),
}));

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

// ── Mock omniroute ────────────────────────────────────────────────────────────

vi.mock("./omniroute", () => ({
  enrichIdea: vi.fn().mockResolvedValue({
    markdown: "---\nstatus: seedling\n---\n# Test Idea\n\nbody\n",
    model: "test",
  }),
  enrichJournal: vi.fn().mockResolvedValue({
    markdown: "---\ndate: 2026-05-16\n---\n# Journal\n\n## Notes\n- thing\n",
    model: "test",
  }),
  enrichPerson: vi.fn().mockResolvedValue({
    markdown: "---\nname: Jane Doe\n---\n# Jane Doe\n",
    model: "test",
  }),
  // Tests inject network errors via mockRejectedValue. None of them throw
  // OmniRouteError, so isPermanentError returns false → drain treats as
  // transient and increments attempts (the existing test expectation).
  isPermanentError: vi.fn().mockReturnValue(false),
}));

// ── Mock writer ───────────────────────────────────────────────────────────────

vi.mock("./writer", () => ({
  writeIdea: vi.fn().mockResolvedValue({ filepath: "file:///carnet/Ideas/test-idea.md" }),
  appendJournal: vi.fn().mockResolvedValue({ filepath: "file:///carnet/Journal/2026-05-16.md" }),
  writePerson: vi.fn().mockResolvedValue({ filepath: "file:///carnet/People/Jane-Doe.md" }),
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  rewriteFrontmatterField: vi.fn(),
  readNote: vi.fn(),
  updateNote: vi.fn(),
}));

// ── Mock @carnet/shared ───────────────────────────────────────────────────────

vi.mock("@carnet/shared", () => ({
  deriveTitle: vi.fn((md: string) => {
    for (const line of md.split("\n")) {
      if (line.startsWith("# ")) return line.slice(2).trim();
    }
    return "Untitled";
  }),
}));

// Import after all mocks are set up
import { enqueue, getQueueDepth, drainQueue } from "./queue";

function clearRows(): void {
  _rows.clear();
}

// Reset the singleton db cache between tests by clearing the module cache isn't
// straightforward in vitest — instead we rely on the mock always returning mockDb.

beforeEach(() => {
  clearRows();
  vi.clearAllMocks();
  // Re-apply stable mock implementations after clearAllMocks
  mockDb.execAsync.mockResolvedValue(undefined);
  mockDb.getAllAsync.mockImplementation(async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
    let rows = Array.from(_rows.values());
    if (sql.includes("attempts <") && params.length > 0) {
      const limit = params[0] as number;
      rows = rows.filter((r) => r.attempts < limit);
    }
    rows.sort((a, b) => a.created_at - b.created_at);
    if (sql.includes("COUNT(*)")) {
      return [{ count: rows.length }];
    }
    return rows;
  });
  mockDb.runAsync.mockImplementation(async (sql: string, ...params: unknown[]) => {
    if (sql.startsWith("INSERT")) {
      const [id, mode, payload_json, created_at] = params as [string, string, string, number];
      _rows.set(id, { id, mode, payload_json, created_at, attempts: 0, last_error: null });
    } else if (sql.startsWith("DELETE")) {
      const id = params[0] as string;
      _rows.delete(id);
    } else if (sql.startsWith("UPDATE")) {
      const [attempts, last_error, id] = params as [number, string, string];
      const row = _rows.get(id);
      if (row) _rows.set(id, { ...row, attempts, last_error });
    }
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueue", () => {
  it("adds a row to the queue", async () => {
    await enqueue({ mode: "idea", text: "my idea" });
    expect(_rows.size).toBe(1);
    const row = Array.from(_rows.values())[0];
    expect(row.mode).toBe("idea");
    expect(JSON.parse(row.payload_json)).toMatchObject({ mode: "idea", text: "my idea" });
  });

  it("increments queue depth", async () => {
    await enqueue({ mode: "idea", text: "idea 1" });
    await enqueue({ mode: "idea", text: "idea 2" });
    await enqueue({ mode: "idea", text: "idea 3" });
    const depth = await getQueueDepth();
    expect(depth).toBe(3);
  });
});

describe("drainQueue", () => {
  it("removes rows on successful processing", async () => {
    const { enrichIdea } = await import("./omniroute");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({ markdown: "---\nstatus: seedling\n---\n# Test Idea\n\nbody\n", model: "t" });
    vi.mocked(writeIdea).mockResolvedValue({ filepath: "file:///carnet/Ideas/test-idea.md" });

    await enqueue({ mode: "idea", text: "drain me" });
    expect(_rows.size).toBe(1);

    await drainQueue();
    expect(_rows.size).toBe(0);
  });

  it("increments attempts on failure and leaves row in queue", async () => {
    const { enrichIdea } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("network error"));

    await enqueue({ mode: "idea", text: "fail me" });
    await drainQueue();

    expect(_rows.size).toBe(1);
    const row = Array.from(_rows.values())[0];
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("network error");
  });

  it("processes rows oldest-first", async () => {
    const { enrichIdea } = await import("./omniroute");
    const calls: string[] = [];
    vi.mocked(enrichIdea).mockImplementation(async (text: string) => {
      calls.push(text);
      return { markdown: `---\nstatus: seedling\n---\n# ${text}\n`, model: "t" };
    });

    // Insert with explicit created_at ordering
    _rows.set("a", { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "first" }), created_at: 100, attempts: 0, last_error: null });
    _rows.set("b", { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "second" }), created_at: 200, attempts: 0, last_error: null });

    await drainQueue();
    expect(calls[0]).toBe("first");
    expect(calls[1]).toBe("second");
  });

  it("processes journal payloads via enrichJournal + appendJournal", async () => {
    const { enrichJournal } = await import("./omniroute");
    const { appendJournal } = await import("./writer");

    await enqueue({ mode: "journal", transcript: "today I did things", notes: "", date: "2026-05-16" });
    await drainQueue();

    expect(vi.mocked(enrichJournal)).toHaveBeenCalledWith({ transcript: "today I did things", notes: "" });
    expect(vi.mocked(appendJournal)).toHaveBeenCalled();
    expect(_rows.size).toBe(0);
  });

  it("processes person payloads via enrichPerson + writePerson", async () => {
    const { enrichPerson } = await import("./omniroute");
    const { writePerson } = await import("./writer");

    await enqueue({ mode: "person", ocrResult: "Jane Doe CEO", context: "conference" });
    await drainQueue();

    expect(vi.mocked(enrichPerson)).toHaveBeenCalledWith({ ocrResult: "Jane Doe CEO", context: "conference" });
    expect(vi.mocked(writePerson)).toHaveBeenCalled();
    expect(_rows.size).toBe(0);
  });

  it("marks 4xx (permanent) errors as permanent failure immediately", async () => {
    const { enrichIdea, isPermanentError } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("401 Unauthorized"));
    // Classify this error as permanent.
    vi.mocked(isPermanentError).mockReturnValueOnce(true);

    await enqueue({ mode: "idea", text: "doomed" });
    await drainQueue();

    expect(_rows.size).toBe(1);
    const row = Array.from(_rows.values())[0];
    // Permanent failure sets attempts to MAX so it won't be re-tried in
    // subsequent drains (queue depth excludes attempts >= MAX).
    expect(row.attempts).toBe(10);
  });

  it("redacts Bearer tokens from stored last_error", async () => {
    const { enrichIdea } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(
      new Error("upstream said: Bearer sk-very-secret-token-xyz invalid"),
    );

    await enqueue({ mode: "idea", text: "leaky" });
    await drainQueue();

    const row = Array.from(_rows.values())[0];
    expect(row.last_error).not.toContain("sk-very-secret-token-xyz");
    expect(row.last_error).toContain("Bearer [redacted]");
  });

  it("single-flight: parallel drainQueue calls do not double-process", async () => {
    const { enrichIdea } = await import("./omniroute");
    const calls: string[] = [];
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.mocked(enrichIdea).mockImplementation(async (text: string) => {
      calls.push(text);
      // Hold the first call so a parallel drainQueue() runs while we're mid-process.
      if (calls.length === 1) await firstHold;
      return { markdown: `---\nstatus: seedling\n---\n# ${text}\n`, model: "t" };
    });

    await enqueue({ mode: "idea", text: "only-once" });

    const drain1 = drainQueue();
    // While drain1 is still mid-flight (awaiting firstHold), kick off a parallel drain.
    const drain2 = drainQueue();
    // Now release the first call.
    resolveFirst();
    await Promise.all([drain1, drain2]);

    // The row should have been processed exactly once.
    expect(calls).toEqual(["only-once"]);
    expect(_rows.size).toBe(0);
  });
});
