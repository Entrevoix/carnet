import { describe, expect, it, vi } from "vitest";

import {
  buildCanonicalImage,
  buildEditorImage,
  resolveImagesForEditor,
  restoreImagesFromEditor,
  toDataUri,
} from "./editorImages";

const DATA = "data:image/jpeg;base64,QUJD"; // "ABC"

/** A resolver that returns a fixed data URI for any path. */
const always = (uri: string) => async () => uri;

describe("toDataUri / builders", () => {
  it("formats a data URI", () => {
    expect(toDataUri("image/png", "QQ==")).toBe("data:image/png;base64,QQ==");
  });

  it("builds editor + canonical embeds", () => {
    expect(buildEditorImage("", DATA, "../Photos/x.jpg")).toBe(
      `![](${DATA} "../Photos/x.jpg")`,
    );
    expect(buildCanonicalImage("alt", "../Photos/x.jpg")).toBe(
      "![alt](../Photos/x.jpg)",
    );
  });
});

describe("resolveImagesForEditor", () => {
  it("swaps a canonical photo embed for a data URI, stashing the path in the title", async () => {
    const out = await resolveImagesForEditor(
      "intro\n\n![](../Photos/a.jpg)\n\noutro",
      always(DATA),
    );
    expect(out).toBe(`intro\n\n![](${DATA} "../Photos/a.jpg")\n\noutro`);
  });

  it("preserves alt text", async () => {
    const out = await resolveImagesForEditor("![a photo](../Photos/a.jpg)", always(DATA));
    expect(out).toBe(`![a photo](${DATA} "../Photos/a.jpg")`);
  });

  it("resolves each unique path once even when embedded multiple times", async () => {
    const resolve = vi.fn(async () => DATA);
    const md = "![](../Photos/a.jpg)\n![](../Photos/a.jpg)\n![](../Photos/b.jpg)";
    await resolveImagesForEditor(md, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("leaves an embed untouched when the resolver returns null (missing / too big)", async () => {
    const md = "![](../Photos/missing.jpg)";
    expect(await resolveImagesForEditor(md, async () => null)).toBe(md);
  });

  it("leaves an embed untouched when the resolver throws", async () => {
    const md = "![](../Photos/boom.jpg)";
    expect(
      await resolveImagesForEditor(md, async () => {
        throw new Error("read failed");
      }),
    ).toBe(md);
  });

  it("does not clobber an embed that already has a markdown title", async () => {
    const md = '![](../Photos/a.jpg "user title")';
    expect(await resolveImagesForEditor(md, always(DATA))).toBe(md);
  });

  it("ignores external and non-Photos links", async () => {
    const md =
      "![](https://example.com/x.png)\n[doc](../Files/spec.pdf)\n[audio](../Audio/clip.m4a)";
    expect(await resolveImagesForEditor(md, always(DATA))).toBe(md);
  });

  it("returns the input unchanged when there are no photo embeds", async () => {
    const resolve = vi.fn();
    const md = "# Title\n\njust prose";
    expect(await resolveImagesForEditor(md, resolve)).toBe(md);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("restoreImagesFromEditor", () => {
  it("rebuilds the canonical embed from the title, discarding the data URI src", () => {
    const editor = `![](${DATA} "../Photos/a.jpg")`;
    expect(restoreImagesFromEditor(editor)).toBe("![](../Photos/a.jpg)");
  });

  it("rebuilds even when the editor mangled the src (only alt + title matter)", () => {
    const mangled = '![alt](data:image/jpeg;base64,TOTALLY-DIFFERENT== "../Photos/a.jpg")';
    expect(restoreImagesFromEditor(mangled)).toBe("![alt](../Photos/a.jpg)");
  });

  it("maps an un-titled data embed back via the known-images fallback", () => {
    const lostTitle = `![](${DATA})`;
    const known = new Map([[DATA, "../Photos/a.jpg"]]);
    expect(restoreImagesFromEditor(lostTitle, known)).toBe("![](../Photos/a.jpg)");
  });

  it("drops an un-recoverable data embed rather than write a base64 blob into the note", () => {
    const lostBoth = `prefix ![](${DATA}) suffix`;
    expect(restoreImagesFromEditor(lostBoth)).toBe("prefix  suffix");
  });

  it("leaves a clean on-disk body unchanged (idempotent)", () => {
    const clean = "# Title\n\n![](../Photos/a.jpg)\n\n![](https://x/y.png)";
    expect(restoreImagesFromEditor(clean)).toBe(clean);
  });

  // ── Catch-all postcondition: a base64 blob must NEVER reach disk ──────────
  // These exercise the failure modes a hostile/lossy serializer could produce.

  it("drops a titled embed whose alt contains ] (serializer can't be trusted)", () => {
    const hostile = `![a]b](${DATA} "../Photos/a.jpg")`;
    const out = restoreImagesFromEditor(hostile);
    expect(out).not.toContain("data:");
  });

  it("drops a title-less data embed whose base64 payload contains whitespace", () => {
    const wrapped = "![](data:image/png;base64,iVBORw0KGg oANSUhEUg)";
    const out = restoreImagesFromEditor(wrapped);
    expect(out).not.toContain("data:");
  });

  it("drops a data embed whose payload was hard-wrapped across a newline", () => {
    const wrapped = "![](data:image/jpeg;base64,QUJD\nRUZH)";
    const out = restoreImagesFromEditor(wrapped);
    expect(out).not.toContain("data:");
  });

  it("never emits a data URI for any of the known failure shapes", () => {
    const shapes = [
      `![](${DATA} "../Photos/a.jpg")`, // happy: title-carried
      `![alt](${DATA} "../Photos/a.jpg")`, // happy with alt
      `![](${DATA})`, // title dropped, no map
      `![a]b](${DATA} "../Photos/a.jpg")`, // hostile alt + title
      `![a]b](${DATA})`, // hostile alt, no title
      "![](data:image/png;base64,AA BB)", // whitespace in payload
      `prose ![](${DATA}) more ![](${DATA} "../Photos/b.jpg") end`, // two on a line
    ];
    for (const shape of shapes) {
      expect(restoreImagesFromEditor(shape)).not.toContain("data:");
    }
  });

  it("does not strip a canonical link that merely contains 'data' in its path", () => {
    // No `data:<mime>/` shape, so the catch-all must leave it alone.
    const md = "![](../Photos/data-export.jpg)";
    expect(restoreImagesFromEditor(md)).toBe(md);
  });
});

describe("round-trip", () => {
  it("resolve → restore returns the original for canonical photo embeds", async () => {
    const original =
      "# Note\n\n![](../Photos/a.jpg)\n\nsome prose\n\n![caption](../Photos/b.png)\n";
    const resolved = await resolveImagesForEditor(original, always(DATA));
    // The editor passes content through unchanged in the happy path.
    expect(restoreImagesFromEditor(resolved)).toBe(original);
  });

  it("a freshly inserted image round-trips to its canonical link", async () => {
    // Insert path: editor receives buildEditorImage(...) directly (no resolve pass).
    const inserted = buildEditorImage("", DATA, "../Photos/new.jpg");
    const body = `existing prose\n\n${inserted}`;
    expect(restoreImagesFromEditor(body)).toBe(
      "existing prose\n\n![](../Photos/new.jpg)",
    );
  });
});
