import { describe, expect, it } from "vitest";

import {
  conflictOriginalName,
  isSyncConflictName,
  pairConflicts,
} from "./syncConflicts";
import type { NoteFileRef } from "./writer";

describe("isSyncConflictName", () => {
  it("matches real Syncthing conflict names", () => {
    expect(isSyncConflictName("note.sync-conflict-20260716-093012-ABC123X.md")).toBe(true);
    expect(isSyncConflictName("2026-07-16.sync-conflict-20260716-221540-XYZQRST.md")).toBe(true);
    // Extensionless (Syncthing appends the marker at the end then)
    expect(isSyncConflictName("README.sync-conflict-20260101-000000-AAAAAAA")).toBe(true);
    // Device-id length is not contractual
    expect(isSyncConflictName("a.sync-conflict-20260716-093012-AB.md")).toBe(true);
  });

  it("does not flag names that merely contain the words", () => {
    expect(isSyncConflictName("my-sync-conflict-notes.md")).toBe(false);
    expect(isSyncConflictName("about.sync-conflict-resolution.md")).toBe(false);
    // Wrong timestamp shapes
    expect(isSyncConflictName("a.sync-conflict-2026716-093012-ABC.md")).toBe(false);
    expect(isSyncConflictName("a.sync-conflict-20260716-0930-ABC.md")).toBe(false);
    expect(isSyncConflictName("plain-note.md")).toBe(false);
  });
});

describe("conflictOriginalName", () => {
  it("strips the marker, preserving stem and extension", () => {
    expect(
      conflictOriginalName("note.sync-conflict-20260716-093012-ABC123X.md"),
    ).toBe("note.md");
    expect(
      conflictOriginalName("2026-07-16.sync-conflict-20260716-221540-XYZQRST.md"),
    ).toBe("2026-07-16.md");
  });

  it("returns non-conflict names unchanged", () => {
    expect(conflictOriginalName("plain-note.md")).toBe("plain-note.md");
  });
});

describe("pairConflicts", () => {
  const ref = (subdir: NoteFileRef["subdir"], name: string): NoteFileRef => ({
    uri: `content://vault/${subdir}/${name}`,
    name,
    subdir,
  });

  it("joins a conflict to its original by subdir + derived name", () => {
    const conflict = ref("Ideas", "note.sync-conflict-20260716-093012-ABC123X.md");
    const original = ref("Ideas", "note.md");
    const pairs = pairConflicts([conflict], [original, ref("Ideas", "other.md")]);
    expect(pairs).toEqual([
      { conflict, originalName: "note.md", original },
    ]);
  });

  it("does not join across subdirs", () => {
    const conflict = ref("Ideas", "note.sync-conflict-20260716-093012-ABC123X.md");
    const journalNote = ref("Journal", "note.md");
    expect(pairConflicts([conflict], [journalNote])[0].original).toBeNull();
  });

  it("yields original: null when the canonical note is gone", () => {
    const conflict = ref("People", "Ada.sync-conflict-20260716-093012-ABC123X.md");
    expect(pairConflicts([conflict], [])).toEqual([
      { conflict, originalName: "Ada.md", original: null },
    ]);
  });
});
