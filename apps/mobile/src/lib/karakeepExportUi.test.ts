import { describe, expect, it } from "vitest";

// The real (pure) frontmatter module backs needsReexportConfirm — stubbing it
// would only test the stub.
import {
  needsReexportConfirm,
  planKarakeepUiUpdate,
  unsupportedSkipNote,
} from "./karakeepExportUi";
import type { KarakeepExportOutcome } from "./karakeepNoteExport";

const EXPORTED_NOTE =
  "---\ncreated: 2026-07-08T11:55:46.000Z\nkarakeepId: bm_abc123\ntags: [qa]\n---\n# Title\n\nBody.\n";
const FRESH_NOTE =
  "---\ncreated: 2026-07-08T11:55:46.000Z\ntags: [qa]\n---\n# Title\n\nBody.\n";

describe("needsReexportConfirm", () => {
  it("is true only when the note carries a karakeepId", () => {
    expect(needsReexportConfirm(EXPORTED_NOTE)).toBe(true);
    expect(needsReexportConfirm(FRESH_NOTE)).toBe(false);
  });

  it("is false for a note with no frontmatter at all", () => {
    expect(needsReexportConfirm("# Just a heading\n\nBody.\n")).toBe(false);
  });

  it("treats an EMPTY karakeepId as never-exported, not as a stamp", () => {
    // Pins the assumption the `!== null` check rests on: extractFrontmatterField
    // reports a blank value as absent, so these must behave like FRESH_NOTE
    // rather than sending the user through a pointless confirm dialog.
    expect(
      needsReexportConfirm(
        '---\ncreated: 2026-07-08T11:55:46.000Z\nkarakeepId: ""\n---\n# Title\n\nBody.\n',
      ),
    ).toBe(false);
    expect(
      needsReexportConfirm(
        "---\ncreated: 2026-07-08T11:55:46.000Z\nkarakeepId:\n---\n# Title\n\nBody.\n",
      ),
    ).toBe(false);
  });

  it("does not confuse a karakeepId in the BODY for a real stamp", () => {
    expect(
      needsReexportConfirm(`${FRESH_NOTE}\nkarakeepId: bm_not_frontmatter\n`),
    ).toBe(false);
  });
});

describe("unsupportedSkipNote", () => {
  it("is null when nothing was skipped", () => {
    expect(unsupportedSkipNote([])).toBeNull();
  });

  it("uses singular 'is' for one file and plural 'are' for several", () => {
    expect(unsupportedSkipNote(["a.zip"])).toBe(
      "a.zip is a file type Karakeep doesn't accept — kept in the vault only",
    );
    expect(unsupportedSkipNote(["a.zip", "b.dmg"])).toBe(
      "a.zip, b.dmg are a file type Karakeep doesn't accept — kept in the vault only",
    );
  });
});

describe("planKarakeepUiUpdate", () => {
  it("queues an unreachable failure instead of erroring", () => {
    const outcome: KarakeepExportOutcome = {
      kind: "failed",
      reason: "Network request failed",
      unreachable: true,
    };
    expect(planKarakeepUiUpdate(outcome)).toEqual({
      kind: "queue",
      fallbackError: "Network request failed",
    });
  });

  it("errors on a failure the server actually answered", () => {
    const outcome: KarakeepExportOutcome = {
      kind: "failed",
      reason: "401 Unauthorized",
      unreachable: false,
    };
    expect(planKarakeepUiUpdate(outcome)).toEqual({
      kind: "error",
      message: "401 Unauthorized",
    });
  });

  it("surfaces a partial export as a banner message that keeps the stamped body", () => {
    const outcome: KarakeepExportOutcome = {
      kind: "partial",
      // Distinct from any input the assertion reuses: the plan must carry the
      // POST-export body through, not the caller's original markdown.
      nextBody: "STAMPED-BODY",
      assetError: "upload 500",
      skippedUnsupported: [],
    };
    expect(planKarakeepUiUpdate(outcome)).toEqual({
      kind: "partial",
      nextBody: "STAMPED-BODY",
      message: "Exported to Karakeep, but an attachment failed: upload 500",
    });
  });

  it("appends the skip notice to a partial message on its own line", () => {
    const outcome: KarakeepExportOutcome = {
      kind: "partial",
      nextBody: "STAMPED-BODY",
      assetError: "upload 500",
      skippedUnsupported: ["a.zip"],
    };
    const plan = planKarakeepUiUpdate(outcome);
    expect(plan.kind).toBe("partial");
    expect(plan.kind === "partial" && plan.message).toBe(
      "Exported to Karakeep, but an attachment failed: upload 500\n" +
        "Also: a.zip is a file type Karakeep doesn't accept — kept in the vault only.",
    );
  });

  it("reports a create as didUpdate:false and an in-place update as true", () => {
    const base = {
      kind: "exported" as const,
      nextBody: "STAMPED-BODY",
      skippedUnsupported: [],
    };
    expect(planKarakeepUiUpdate({ ...base, didUpdate: false })).toEqual({
      kind: "success",
      nextBody: "STAMPED-BODY",
      didUpdate: false,
      skipNote: null,
    });
    expect(planKarakeepUiUpdate({ ...base, didUpdate: true })).toEqual({
      kind: "success",
      nextBody: "STAMPED-BODY",
      didUpdate: true,
      skipNote: null,
    });
  });

  it("carries the skip notice on a fully successful export", () => {
    expect(
      planKarakeepUiUpdate({
        kind: "exported",
        nextBody: "STAMPED-BODY",
        didUpdate: false,
        skippedUnsupported: ["a.zip", "b.dmg"],
      }),
    ).toEqual({
      kind: "success",
      nextBody: "STAMPED-BODY",
      didUpdate: false,
      skipNote:
        "a.zip, b.dmg are a file type Karakeep doesn't accept — kept in the vault only",
    });
  });
});
