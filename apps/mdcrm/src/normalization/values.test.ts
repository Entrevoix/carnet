import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeIsoDate, normalizeName, normalizeOrganization, normalizePhone, normalizeUrl, normalizeWhitespace } from "./values.js";

describe("deterministic normalization", () => {
  it("normalizes whitespace, Unicode, email, name, and company comparison forms", () => {
    expect(normalizeWhitespace("  JANE\u0000   SMITH  ")).toBe("JANE SMITH");
    expect(normalizeEmail(" Jane.Smith@ACME.com ")).toBe("jane.smith@acme.com");
    expect(normalizeName(" JÁNE   SMITH ")).toBe("jane smith");
    expect(normalizeOrganization("Acme Industries, Ltd.")).toBe("acme industries");
  });
  it("normalizes unambiguous phone numbers and refuses ambiguous ones", () => {
    expect(normalizePhone("+1 (202) 555-0142")).toBe("+12025550142");
    expect(normalizePhone("020 7946 0958")).toBe("");
    expect(normalizePhone("020 7946 0958", "44")).toBe("+442079460958");
  });
  it("normalizes URLs and ISO dates without guessing ambiguous dates", () => {
    expect(normalizeUrl("ACME.Example/")).toBe("https://acme.example");
    expect(normalizeIsoDate("2026-08-03")).toBe("2026-08-03");
    expect(normalizeIsoDate("03/08/2026")).toBe("");
  });
});
