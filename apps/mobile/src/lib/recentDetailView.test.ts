import { describe, expect, it } from "vitest";

import {
  activeIssueMessage,
  busyLabel,
  formatDate,
  formatMode,
  isActionsBusy,
  karakeepSnackbarMessage,
  noteCapabilities,
  relatedSubdirForMode,
} from "./recentDetailView";

const NO_ISSUES = {
  editError: null,
  karakeepError: null,
  transcribeError: null,
  reEnrichError: null,
};
const NOT_BUSY = {
  reEnriching: false,
  transcribing: false,
  exportingKarakeep: false,
};

describe("formatMode", () => {
  it("gives each mode a distinct human label", () => {
    // Asserted as a whole map so a swapped pair (person -> "Photo") fails.
    expect({
      idea: formatMode("idea"),
      journal: formatMode("journal"),
      person: formatMode("person"),
      photo: formatMode("photo"),
      audio: formatMode("audio"),
    }).toEqual({
      idea: "Idea",
      journal: "Journal",
      // "Contact", not "Person" — the user-facing word for the People vault.
      person: "Contact",
      photo: "Photo",
      audio: "Audio",
    });
  });
});

describe("formatDate", () => {
  it("renders the unix ms instant, not the raw number", () => {
    const unix = 1_751_975_746_000;
    const out = formatDate(unix);
    // Locale-stable pin: the year (2025) must appear, and the raw epoch
    // number must not — this fails if formatDate stops rendering the
    // actual date (e.g. drops to a fixed/empty string) without depending
    // on the exact locale formatting the test environment produces.
    expect(out).toContain("2025");
    expect(out).not.toContain(String(unix));
  });
});

describe("activeIssueMessage", () => {
  it("returns null when nothing failed", () => {
    expect(activeIssueMessage(NO_ISSUES)).toBeNull();
  });

  it("prefixes each error with the operation that produced it", () => {
    expect(activeIssueMessage({ ...NO_ISSUES, editError: "disk full" })).toBe(
      "Save failed: disk full",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, karakeepError: "401" })).toBe(
      "Karakeep export failed: 401",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, transcribeError: "no model" })).toBe(
      "Transcribe failed: no model",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, reEnrichError: "timeout" })).toBe(
      "Re-enrich failed: timeout",
    );
  });

  it("gives the save error precedence over every other failure", () => {
    // All four set with DISTINCT reasons: whichever branch runs is visible in
    // the output, so reordering the precedence chain cannot stay green.
    expect(
      activeIssueMessage({
        editError: "save-reason",
        karakeepError: "karakeep-reason",
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
      }),
    ).toBe("Save failed: save-reason");
  });

  it("orders the remaining three karakeep > transcribe > re-enrich", () => {
    expect(
      activeIssueMessage({
        editError: null,
        karakeepError: "karakeep-reason",
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
      }),
    ).toBe("Karakeep export failed: karakeep-reason");
    expect(
      activeIssueMessage({
        editError: null,
        karakeepError: null,
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
      }),
    ).toBe("Transcribe failed: transcribe-reason");
  });
});

describe("busyLabel", () => {
  it("returns null when idle", () => {
    expect(busyLabel(NOT_BUSY)).toBeNull();
  });

  it("names the running operation", () => {
    expect(busyLabel({ ...NOT_BUSY, reEnriching: true })).toBe(
      "Re-running vision enrichment…",
    );
    expect(busyLabel({ ...NOT_BUSY, transcribing: true })).toBe(
      "Transcribing audio…",
    );
    expect(busyLabel({ ...NOT_BUSY, exportingKarakeep: true })).toBe(
      "Sending to Karakeep…",
    );
  });

  it("orders re-enrich > transcribe > karakeep when several overlap", () => {
    expect(
      busyLabel({ reEnriching: true, transcribing: true, exportingKarakeep: true }),
    ).toBe("Re-running vision enrichment…");
    expect(
      busyLabel({ reEnriching: false, transcribing: true, exportingKarakeep: true }),
    ).toBe("Transcribing audio…");
  });
});

describe("isActionsBusy", () => {
  it("is false only when all three are idle", () => {
    expect(isActionsBusy(NOT_BUSY)).toBe(false);
    expect(isActionsBusy({ ...NOT_BUSY, reEnriching: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, transcribing: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, exportingKarakeep: true })).toBe(true);
  });
});

describe("noteCapabilities", () => {
  it("offers re-enrich only for kinds whose raw input is on disk", () => {
    expect(noteCapabilities("photo", false).canReEnrich).toBe(true);
    expect(noteCapabilities("shared-image", false).canReEnrich).toBe(true);
    for (const kind of ["idea", "journal", "person", "shared-audio", "shared-link", ""]) {
      expect(noteCapabilities(kind, false).canReEnrich).toBe(false);
    }
  });

  it("offers transcribe only for audio notes", () => {
    expect(noteCapabilities("shared-audio", false).canTranscribe).toBe(true);
    for (const kind of ["photo", "shared-image", "idea", ""]) {
      expect(noteCapabilities(kind, false).canTranscribe).toBe(false);
    }
  });

  it("hides the player for an audio note whose file is missing", () => {
    expect(noteCapabilities("shared-audio", true)).toEqual({
      canReEnrich: false,
      canTranscribe: true,
      showAudioPlayer: false,
    });
    expect(noteCapabilities("shared-audio", false).showAudioPlayer).toBe(true);
  });

  it("never shows the player for a non-audio kind, missing or not", () => {
    expect(noteCapabilities("photo", false).showAudioPlayer).toBe(false);
    expect(noteCapabilities("photo", true).showAudioPlayer).toBe(false);
  });
});

describe("relatedSubdirForMode", () => {
  it("maps each mode onto its vault subdir", () => {
    expect({
      journal: relatedSubdirForMode("journal"),
      person: relatedSubdirForMode("person"),
      idea: relatedSubdirForMode("idea"),
      photo: relatedSubdirForMode("photo"),
      audio: relatedSubdirForMode("audio"),
    }).toEqual({
      journal: "Journal",
      person: "People",
      // photo/audio captures land in Ideas/ alongside idea notes.
      idea: "Ideas",
      photo: "Ideas",
      audio: "Ideas",
    });
  });
});

describe("karakeepSnackbarMessage", () => {
  it("distinguishes an in-place update from a fresh export", () => {
    expect(karakeepSnackbarMessage(true, null)).toBe("Updated in Karakeep");
    expect(karakeepSnackbarMessage(false, null)).toBe("Exported to Karakeep");
  });

  it("appends the skip notice as its own sentence", () => {
    expect(karakeepSnackbarMessage(false, "a.zip is a file type")).toBe(
      "Exported to Karakeep. a.zip is a file type.",
    );
    expect(karakeepSnackbarMessage(true, "a.zip is a file type")).toBe(
      "Updated in Karakeep. a.zip is a file type.",
    );
  });
});
