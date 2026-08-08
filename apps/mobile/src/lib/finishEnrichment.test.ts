// Copyright (C) 2025 Entrevoix, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", () => ({
  getModificationTime: vi.fn(async () => 1000),
  readNote: vi.fn(async () => {
    throw new Error("not stubbed");
  }),
}));
// Fully mocked, not importActual: the real module reaches expo-modules-core,
// which needs a React Native runtime (`__DEV__`). Same approach as
// enhanceProse.test.ts's dispatcher mock.
vi.mock("./ideaSaveFirst", () => ({
  enrichIdeaInPlace: vi.fn(),
  PENDING_ENRICH_STATUS: "pending-enrich",
}));

import { finishPendingEnrichment, isPendingEnrich } from "./finishEnrichment";
import { getModificationTime, readNote } from "./writer";
import { enrichIdeaInPlace } from "./ideaSaveFirst";

const mockMtime = vi.mocked(getModificationTime);
const mockReadNote = vi.mocked(readNote);
const mockEnrich = vi.mocked(enrichIdeaInPlace);

const PENDING = `---
created: 2026-08-08T13:54:22.852Z
status: pending-enrich
tags: [travel]
location: 47.20114,10.11660
---
Stroudsburg Pennsylvania and the Pocono Mountains region.
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockMtime.mockResolvedValue(1000);
  mockReadNote.mockResolvedValue(PENDING);
  mockEnrich.mockResolvedValue({ kind: "updated", markdown: "# Enriched\n\nbody\n" });
});

describe("isPendingEnrich", () => {
  it("detects a raw save-first capture", () => {
    expect(isPendingEnrich(PENDING)).toBe(true);
  });

  it("is false for an enriched note", () => {
    expect(isPendingEnrich("---\nstatus: seedling\n---\nbody")).toBe(false);
  });

  it("is false for a note with no frontmatter at all", () => {
    expect(isPendingEnrich("just prose")).toBe(false);
  });
});

describe("finishPendingEnrichment", () => {
  it("enriches the raw text and returns the new markdown", async () => {
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out).toEqual({ kind: "updated", markdown: "# Enriched\n\nbody\n" });
    // The user's raw text is what goes to the model — not the frontmatter.
    const arg = mockEnrich.mock.calls[0][0];
    expect(arg.text).toBe("Stroudsburg Pennsylvania and the Pocono Mountains region.");
    expect(arg.text).not.toContain("status:");
  });

  it("preserves the tags and location the user set at capture", async () => {
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    const arg = mockEnrich.mock.calls[0][0];
    expect(arg.tags).toEqual(["travel"]);
    expect(arg.location).toBe("47.20114,10.11660");
  });

  it("captures the mtime baseline BEFORE the model call", async () => {
    // Same ordering enhanceProse.ts uses: a baseline taken after the call would
    // match whatever a mid-flight edit produced, making the guard useless.
    const order: string[] = [];
    mockMtime.mockImplementation(async () => {
      order.push("mtime");
      return 1000;
    });
    mockEnrich.mockImplementation(async () => {
      order.push("enrich");
      return { kind: "updated", markdown: "x" };
    });
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(order).toEqual(["mtime", "enrich"]);
  });

  it("prefers the file's CURRENT content over the caller's snapshot", async () => {
    mockReadNote.mockResolvedValue(
      PENDING.replace("Stroudsburg Pennsylvania", "EDITED ON DISK"),
    );
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(mockEnrich.mock.calls[0][0].text).toContain("EDITED ON DISK");
  });

  it("refuses a note that is not awaiting enrichment", async () => {
    mockReadNote.mockResolvedValue("---\nstatus: seedling\n---\nbody");
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("surfaces a mid-flight conflict as a reason rather than clobbering", async () => {
    // This is the exact state the feature exists for: the queued drain already
    // conflicted once and dropped its row. A second conflict must not overwrite.
    mockEnrich.mockResolvedValue({ kind: "conflict" });
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/changed while/i);
  });

  it("never throws — a failed enrichment comes back as a reason", async () => {
    mockEnrich.mockResolvedValue({ kind: "failed", transient: true, reason: "network down" });
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out).toEqual({ kind: "failed", reason: "network down" });
  });

  it("never throws when the mtime read itself blows up", async () => {
    mockMtime.mockRejectedValue(new Error("SAF exploded"));
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
  });

  it("refuses a pending note whose body is empty", async () => {
    mockReadNote.mockResolvedValue("---\nstatus: pending-enrich\n---\n\n");
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
  });
});
