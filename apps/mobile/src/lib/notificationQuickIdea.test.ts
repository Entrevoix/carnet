import { beforeEach, describe, expect, it, vi } from "vitest";

// notificationQuickIdea orchestrates the save-first path for the notification
// inline-reply (B5). Its disk-write / enrichment / mtime internals live in
// ideaSaveFirst.ts and are covered by ideaSaveFirst.test.ts; here we mock those
// collaborators and assert the HEADLESS orchestration: the empty-input no-op,
// that the save-first write happens before enrichment (no app open), the
// recents bookkeeping, and the transient-failure enqueue — exactly what B5 adds.

// ── Mock the save-first primitives ───────────────────────────────────────────

const writeRawIdeaMock = vi.fn();
const enrichIdeaInPlaceMock = vi.fn();

vi.mock("./ideaSaveFirst", () => ({
  writeRawIdea: (...args: unknown[]) => writeRawIdeaMock(...args),
  enrichIdeaInPlace: (...args: unknown[]) => enrichIdeaInPlaceMock(...args),
}));

// ── Mock recents / index / queue side effects ────────────────────────────────

const recordCaptureMock = vi.fn().mockResolvedValue(undefined);
const invalidateTagIndexMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./storage", () => ({
  recordCapture: (...args: unknown[]) => recordCaptureMock(...args),
}));
vi.mock("./vault", () => ({
  invalidateTagIndex: (...args: unknown[]) => invalidateTagIndexMock(...args),
}));
vi.mock("./queue", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
}));
vi.mock("@carnet/shared", () => ({
  deriveTitle: vi.fn((text: string) => text.split("\n")[0]?.trim() || ""),
}));

import { handleQuickIdeaCapture } from "./notificationQuickIdea";

beforeEach(() => {
  writeRawIdeaMock.mockReset();
  enrichIdeaInPlaceMock.mockReset();
  recordCaptureMock.mockReset().mockResolvedValue(undefined);
  invalidateTagIndexMock.mockReset().mockResolvedValue(undefined);
  enqueueMock.mockReset().mockResolvedValue(undefined);
});

/** Default happy-path stubs: raw write lands, enrichment updates in place. */
function happyPath(): void {
  writeRawIdeaMock.mockResolvedValue({
    filepath: "file:///data/Ideas/quick.md",
    slug: "quick",
    mtime: 1001,
  });
  enrichIdeaInPlaceMock.mockResolvedValue({ kind: "updated" });
}

// ── Empty-input no-op (required behavior 3) ──────────────────────────────────

describe("handleQuickIdeaCapture — empty input", () => {
  it("no-ops on an empty string — nothing written, nothing enriched", async () => {
    const result = await handleQuickIdeaCapture("");
    expect(result).toEqual({ kind: "empty" });
    expect(writeRawIdeaMock).not.toHaveBeenCalled();
    expect(enrichIdeaInPlaceMock).not.toHaveBeenCalled();
    expect(recordCaptureMock).not.toHaveBeenCalled();
  });

  it("no-ops on whitespace-only input", async () => {
    const result = await handleQuickIdeaCapture("   \n\t  ");
    expect(result).toEqual({ kind: "empty" });
    expect(writeRawIdeaMock).not.toHaveBeenCalled();
  });

  it("no-ops on null/undefined-ish input without throwing", async () => {
    // The native bridge could hand across a missing extra.
    const result = await handleQuickIdeaCapture(undefined as unknown as string);
    expect(result).toEqual({ kind: "empty" });
    expect(writeRawIdeaMock).not.toHaveBeenCalled();
  });
});

// ── Save-first write lands before enrichment (required behavior 1) ────────────

describe("handleQuickIdeaCapture — save-first ordering", () => {
  it("writes the raw note via the save-first path BEFORE enriching (app never opens)", async () => {
    const order: string[] = [];
    writeRawIdeaMock.mockImplementation(async () => {
      order.push("write");
      return { filepath: "file:///data/Ideas/kite.md", slug: "kite", mtime: 1001 };
    });
    enrichIdeaInPlaceMock.mockImplementation(async () => {
      order.push("enrich");
      return { kind: "updated" };
    });

    const result = await handleQuickIdeaCapture("Build a kite");

    expect(order).toEqual(["write", "enrich"]);
    // The raw text (trimmed) is what gets written — no LLM in the write path.
    expect(writeRawIdeaMock).toHaveBeenCalledWith({ text: "Build a kite", tags: [] });
    expect(result).toEqual({ kind: "enriched" });
  });

  it("trims the submitted text before writing", async () => {
    happyPath();
    await handleQuickIdeaCapture("  padded idea  ");
    expect(writeRawIdeaMock).toHaveBeenCalledWith({ text: "padded idea", tags: [] });
  });

  it("records a recents entry and invalidates the tag index after the write", async () => {
    happyPath();
    await handleQuickIdeaCapture("Note me");
    expect(recordCaptureMock).toHaveBeenCalledTimes(1);
    const entry = recordCaptureMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      mode: "idea",
      title: "Note me",
      filepath: "file:///data/Ideas/quick.md",
    });
    expect(entry.id).toBeTruthy();
    expect(invalidateTagIndexMock).toHaveBeenCalledTimes(1);
  });

  it("still reports success if recents bookkeeping throws (note is safe on disk)", async () => {
    happyPath();
    recordCaptureMock.mockRejectedValue(new Error("AsyncStorage unavailable"));
    const result = await handleQuickIdeaCapture("resilient");
    expect(result).toEqual({ kind: "enriched" });
  });
});

// ── Enrichment fires async after the write (required behavior 2) ──────────────

describe("handleQuickIdeaCapture — async enrichment outcomes", () => {
  it("passes the raw-write mtime baseline into enrichIdeaInPlace as the guard", async () => {
    happyPath();
    await handleQuickIdeaCapture("guard me");
    expect(enrichIdeaInPlaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: "file:///data/Ideas/quick.md",
        expectedMtime: 1001,
        text: "guard me",
        tags: [],
      }),
    );
  });

  it("queues the capture for a later drain on a TRANSIENT enrichment failure", async () => {
    writeRawIdeaMock.mockResolvedValue({
      filepath: "file:///data/Ideas/offline.md",
      slug: "offline",
      mtime: 2002,
    });
    enrichIdeaInPlaceMock.mockResolvedValue({
      kind: "failed",
      transient: true,
      reason: "network down",
    });

    const result = await handleQuickIdeaCapture("offline idea");

    expect(result).toEqual({ kind: "queued" });
    // Re-enqueue must target the note already on disk (filepath + baselineMtime)
    // so the drain updates it in place instead of writing a duplicate.
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "idea",
        text: "offline idea",
        filepath: "file:///data/Ideas/offline.md",
        baselineMtime: 2002,
      }),
    );
  });

  it("does NOT queue on a PERMANENT enrichment failure — reports degraded", async () => {
    happyPath();
    enrichIdeaInPlaceMock.mockResolvedValue({
      kind: "failed",
      transient: false,
      reason: "HTTP 400",
    });
    const result = await handleQuickIdeaCapture("bad request");
    expect(result).toEqual({ kind: "degraded", reason: "HTTP 400" });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("reports conflict (user version kept) when the note changed during enrichment", async () => {
    happyPath();
    enrichIdeaInPlaceMock.mockResolvedValue({ kind: "conflict" });
    const result = await handleQuickIdeaCapture("racey");
    expect(result).toEqual({ kind: "conflict" });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("still reports queued if the enqueue itself fails (raw note remains on disk)", async () => {
    happyPath();
    enrichIdeaInPlaceMock.mockResolvedValue({
      kind: "failed",
      transient: true,
      reason: "timeout",
    });
    enqueueMock.mockRejectedValue(new Error("queue write failed"));
    const result = await handleQuickIdeaCapture("still safe");
    expect(result).toEqual({ kind: "queued" });
  });
});

// ── Raw-write failure — nothing saved, no enrichment attempted ────────────────

describe("handleQuickIdeaCapture — raw write failure", () => {
  it("reports write-failed and does not enrich when the raw write throws", async () => {
    writeRawIdeaMock.mockRejectedValue(new Error("disk full"));
    const result = await handleQuickIdeaCapture("cannot save");
    expect(result).toEqual({ kind: "write-failed", reason: "disk full" });
    expect(enrichIdeaInPlaceMock).not.toHaveBeenCalled();
    expect(recordCaptureMock).not.toHaveBeenCalled();
  });
});
