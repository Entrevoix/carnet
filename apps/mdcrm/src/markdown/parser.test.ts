import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdownRecord, renderMarkdownRecord } from "./parser.js";
import { SchemaRegistry } from "../schemas/registry.js";

const fixture = fileURLToPath(new URL("../../fixtures/capture-business-card.md", import.meta.url));

describe("Markdown record boundary", () => {
  it("parses, validates, and renders the golden capture fixture", () => {
    const record = parseMarkdownRecord(readFileSync(fixture, "utf8"), fixture);
    new SchemaRegistry().validate(record.frontmatter, fixture);
    const reparsed = parseMarkdownRecord(renderMarkdownRecord(record));
    expect(reparsed.frontmatter).toEqual(record.frontmatter);
    expect(reparsed.body).toBe(record.body);
  });
  it("validates every checked-in Markdown fixture", () => {
    const registry = new SchemaRegistry();
    for (const name of readdirSync(dirname(fixture)).filter((entry) => entry.endsWith(".md"))) {
      const path = join(dirname(fixture), name);
      registry.validate(parseMarkdownRecord(readFileSync(path, "utf8"), path).frontmatter, path);
    }
  });
  it("reports malformed YAML with a source path", () => {
    expect(() => parseMarkdownRecord("---\nid: [\n---\n# Bad\n", "bad.md")).toThrow(/bad\.md: invalid YAML/);
  });
  it("rejects invalid schemas with field paths", () => {
    const record = parseMarkdownRecord("---\nschema_version: 1\ntype: capture\nid: nope\n---\n# Bad\n");
    expect(() => new SchemaRegistry().validate(record.frontmatter)).toThrow(/\/id/);
  });
});
