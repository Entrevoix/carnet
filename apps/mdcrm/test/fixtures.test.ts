import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseMarkdownRecord, renderMarkdownRecord } from "../src/markdown/parser.js";
import { SchemaRegistry } from "../src/schemas/registry.js";

const fixtureDir = fileURLToPath(new URL("../fixtures", import.meta.url));

/**
 * `docs/mdcrm/schema-migrations.md` makes these fixtures the golden examples
 * that pin rendered output per schema version, but only the business-card one
 * was ever loaded by a test — the other eight could drift out of sync with
 * their schemas silently. Pinning the expected type set here also means adding
 * a record type without adding its fixture fails loudly.
 */
const EXPECTED_TYPES = [
  "capture", "contact", "event", "interaction", "organization",
  "processing_job", "proposed_change", "review_item", "task",
];

describe("golden fixtures", () => {
  it("validates every bundled fixture against its schema and covers every record type", async () => {
    const registry = new SchemaRegistry();
    const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".md")).sort();
    expect(names.length).toBeGreaterThan(0);

    const seen: string[] = [];
    for (const name of names) {
      const record = parseMarkdownRecord(await readFile(join(fixtureDir, name), "utf8"), name);
      expect(() => registry.validate(record.frontmatter, name)).not.toThrow();
      seen.push(record.frontmatter.type);
    }

    expect([...new Set(seen)].sort()).toEqual(EXPECTED_TYPES);
  });

  it("round-trips every fixture through parse and render without losing frontmatter", async () => {
    const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".md")).sort();
    for (const name of names) {
      const original = parseMarkdownRecord(await readFile(join(fixtureDir, name), "utf8"), name);
      const reparsed = parseMarkdownRecord(renderMarkdownRecord(original), name);
      expect(reparsed.frontmatter).toEqual(original.frontmatter);
    }
  });
});
