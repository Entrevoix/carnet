import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock ───────────────────────────────────────────────
// Same pattern as storage.test.ts — the queue is now a JSON array under one key
// instead of a SQLite table. We can't pull in the real native binding under Node.

interface Row {
  id: string;
  mode: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

const QUEUE_KEY = "carnet:queue:v1";
const _store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    omniRouteVisionModel: "",
    llmBackend: "omniroute",
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: "",
    captureFolderPath: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: false,
    previewBeforeSave: false,
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  }),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
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
  // Default false; the not-configured drain test flips it on for one pass.
  isNotConfiguredError: vi.fn().mockReturnValue(false),
}));

// ── Mock localLlm (dispatcher now imports it) ────────────────────────────────

vi.mock("./localLlm", () => ({
  enrichIdea: vi.fn(),
  enrichJournal: vi.fn(),
  enrichPerson: vi.fn(),
  enrichSharedImage: vi.fn(),
  enrichSharedLink: vi.fn(),
  promoteIdea: vi.fn(),
  ocrCardViaVision: vi.fn(),
  listModels: vi.fn(),
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
  // Lightweight stand-in for the real injectAttachments (unit-tested in
  // writer.test.ts). Enough to assert processRow wires attachments → body →
  // writeIdea/appendJournal: images become embeds, files become links.
  injectAttachments: vi.fn(
    (md: string, atts: { kind: string; rel: string; filename: string }[]) =>
      atts.reduce(
        (acc, a) =>
          a.kind === "image"
            ? `${acc}\n![](${a.rel})\n`
            : `${acc}\n[${a.filename}](${a.rel})\n`,
        md,
      ),
  ),
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
import {
  enqueue,
  getQueueCounts,
  getQueueDepth,
  drainQueue,
  listQueueRows,
} from "./queue";

/** Current persisted queue rows (parsed from the AsyncStorage mock). */
function rows(): Row[] {
  const raw = _store.get(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as Row[]) : [];
}

/** Directly seed the queue store, bypassing enqueue (for ordering tests). */
function seed(seedRows: Row[]): void {
  _store.set(QUEUE_KEY, JSON.stringify(seedRows));
}

describe("getQueueCounts", () => {
  it("splits pending vs permanently-failed rows", async () => {
    seed([
      { id: "a", mode: "idea", payload_json: "{}", created_at: 1, attempts: 0, last_error: null },
      { id: "b", mode: "idea", payload_json: "{}", created_at: 2, attempts: 3, last_error: "5xx" },
      { id: "c", mode: "idea", payload_json: "{}", created_at: 3, attempts: 10, last_error: "401" },
    ]);
    expect(await getQueueCounts()).toEqual({ pending: 2, failed: 1 });
  });

  it("returns zeros on an empty queue", async () => {
    _store.delete(QUEUE_KEY);
    expect(await getQueueCounts()).toEqual({ pending: 0, failed: 0 });
  });
});

describe("listQueueRows", () => {
  it("returns a snapshot whose mutation doesn't touch the stored queue", async () => {
    seed([
      { id: "a", mode: "idea", payload_json: "{}", created_at: 1, attempts: 2, last_error: "5xx" },
    ]);
    const snapshot = await listQueueRows();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].attempts).toBe(2);
    snapshot[0].attempts = 99;
    expect((await listQueueRows())[0].attempts).toBe(2);
  });
});

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueue", () => {
  it("adds a row to the queue", async () => {
    await enqueue({ mode: "idea", text: "my idea" });
    expect(rows().length).toBe(1);
    const row = rows()[0];
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
    expect(rows().length).toBe(1);

    await drainQueue();
    expect(rows().length).toBe(0);
  });

  it("removes a corrupt payload_json row during drain", async () => {
    seed([
      { id: "x", mode: "idea", payload_json: "{not valid json", created_at: 1, attempts: 0, last_error: null },
    ]);
    await drainQueue();
    expect(rows().length).toBe(0);
  });

  it("increments attempts on failure and leaves row in queue", async () => {
    const { enrichIdea } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("network error"));

    await enqueue({ mode: "idea", text: "fail me" });
    await drainQueue();

    expect(rows().length).toBe(1);
    const row = rows()[0];
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("network error");
  });

  it("leaves rows untouched (no attempts burned) when OmniRoute is not configured", async () => {
    const { enrichIdea, isNotConfiguredError } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("not configured"));
    // Classify the first failure as a config problem (drain breaks after one,
    // so Once is enough and won't leak into later tests via clearAllMocks).
    vi.mocked(isNotConfiguredError).mockReturnValueOnce(true);

    // Two pending rows: the pass must stop on the first without bumping either.
    seed([
      { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "one" }), created_at: 100, attempts: 0, last_error: null },
      { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "two" }), created_at: 200, attempts: 0, last_error: null },
    ]);

    await drainQueue();

    // Both rows survive with attempts still 0 — they'll drain once a URL is set.
    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.attempts === 0)).toBe(true);
    expect(rows().every((r) => r.last_error === null)).toBe(true);
  });

  it("processes rows oldest-first", async () => {
    const { enrichIdea } = await import("./omniroute");
    const calls: string[] = [];
    vi.mocked(enrichIdea).mockImplementation(async (text: string) => {
      calls.push(text);
      return { markdown: `---\nstatus: seedling\n---\n# ${text}\n`, model: "t" };
    });

    // Seed with explicit created_at ordering (second appears first in the array).
    seed([
      { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "second" }), created_at: 200, attempts: 0, last_error: null },
      { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "first" }), created_at: 100, attempts: 0, last_error: null },
    ]);

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
    expect(rows().length).toBe(0);
  });

  it("processes person payloads via enrichPerson + writePerson", async () => {
    const { enrichPerson } = await import("./omniroute");
    const { writePerson } = await import("./writer");

    await enqueue({ mode: "person", ocrResult: "Jane Doe CEO", context: "conference" });
    await drainQueue();

    expect(vi.mocked(enrichPerson)).toHaveBeenCalledWith({ ocrResult: "Jane Doe CEO", context: "conference" });
    expect(vi.mocked(writePerson)).toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("folds queued attachments into the body before writing (idea)", async () => {
    const { writeIdea, injectAttachments } = await import("./writer");

    await enqueue({
      mode: "idea",
      text: "with files",
      attachments: [
        { kind: "image", rel: "../Photos/a.jpg", filename: "a.jpg" },
        { kind: "file", rel: "../Files/b.pdf", filename: "b.pdf" },
      ],
    });
    await drainQueue();

    // Attachments were handed to injectAttachments, and its output reached disk.
    expect(vi.mocked(injectAttachments)).toHaveBeenCalledWith(
      expect.any(String),
      [
        { kind: "image", rel: "../Photos/a.jpg", filename: "a.jpg" },
        { kind: "file", rel: "../Files/b.pdf", filename: "b.pdf" },
      ],
    );
    const writtenBody = vi.mocked(writeIdea).mock.calls[0][1];
    expect(writtenBody).toContain("![](../Photos/a.jpg)");
    expect(writtenBody).toContain("[b.pdf](../Files/b.pdf)");
    expect(rows().length).toBe(0);
  });

  it("drains a legacy row with no attachments field unchanged", async () => {
    // Rows queued before this feature have no `attachments` key — they must
    // drain exactly as before (injectAttachments gets an empty list).
    const { writeIdea } = await import("./writer");
    seed([
      { id: "old", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "legacy" }), created_at: 1, attempts: 0, last_error: null },
    ]);

    await drainQueue();

    expect(vi.mocked(writeIdea)).toHaveBeenCalledTimes(1);
    expect(rows().length).toBe(0);
  });

  it("merges queued tags into the idea frontmatter on drain (offline parity)", async () => {
    const { enrichIdea } = await import("./omniroute");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Tagged Idea\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "tag me", tags: ["work", "urgent"] });
    await drainQueue();

    const writtenBody = vi.mocked(writeIdea).mock.calls[0][1];
    expect(writtenBody).toContain("tags: [work, urgent]");
    expect(rows().length).toBe(0);
  });

  it("preserves LLM-emitted tags when merging queued user tags (idea)", async () => {
    const { enrichIdea } = await import("./omniroute");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\ntags: [seedling]\n---\n# Merge Idea\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "merge me", tags: ["Work"] });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).toContain("tags: [seedling, work]");
  });

  it("merges queued tags into journal + person frontmatter on drain", async () => {
    const { appendJournal, writePerson } = await import("./writer");

    await enqueue({
      mode: "journal",
      transcript: "did things",
      notes: "",
      date: "2026-05-16",
      tags: ["daily"],
    });
    await enqueue({ mode: "person", ocrResult: "Jane", context: "conf", tags: ["lead"] });
    await drainQueue();

    expect(vi.mocked(appendJournal).mock.calls[0][1]).toContain("tags: [daily]");
    // writePerson(firstName, lastName, markdown) — markdown is the 3rd arg.
    expect(vi.mocked(writePerson).mock.calls[0][2]).toContain("tags: [lead]");
  });

  it("leaves the body untouched when a queued row carries no tags", async () => {
    const { enrichIdea } = await import("./omniroute");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Untagged\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "no tags", tags: [] });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).not.toContain("tags:");
  });

  it("injects a queued location into the idea frontmatter on drain", async () => {
    const { enrichIdea } = await import("./omniroute");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Located\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "where", location: "38.90720,-77.03690" });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).toContain("location: 38.90720,-77.03690");
  });

  it("injects a queued location into journal + person frontmatter on drain", async () => {
    const { appendJournal, writePerson } = await import("./writer");

    await enqueue({
      mode: "journal",
      transcript: "t",
      notes: "",
      date: "2026-05-16",
      location: "1,2",
    });
    await enqueue({ mode: "person", ocrResult: "Jane", context: "conf", location: "3,4" });
    await drainQueue();

    expect(vi.mocked(appendJournal).mock.calls[0][1]).toContain("location: 1,2");
    expect(vi.mocked(writePerson).mock.calls[0][2]).toContain("location: 3,4");
  });

  it("marks 4xx (permanent) errors as permanent failure immediately", async () => {
    const { enrichIdea, isPermanentError } = await import("./omniroute");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("401 Unauthorized"));
    // Classify this error as permanent.
    vi.mocked(isPermanentError).mockReturnValueOnce(true);

    await enqueue({ mode: "idea", text: "doomed" });
    await drainQueue();

    expect(rows().length).toBe(1);
    const row = rows()[0];
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

    const row = rows()[0];
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
    expect(rows().length).toBe(0);
  });
});
