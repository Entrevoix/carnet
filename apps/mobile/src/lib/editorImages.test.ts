import { describe, expect, it } from "vitest";

import {
  buildCanonicalImage,
  buildEditorImage,
  isSuspiciousBlanking,
  photoEmbedRels,
  restoreImagesFromEditor,
  toDataUri,
} from "./editorImages";

const DATA = "data:image/jpeg;base64,QUJD"; // "ABC"

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

describe("photoEmbedRels", () => {
  it("lists each unique Photos embed once, in document order", () => {
    const md = "![](../Photos/a.jpg)\n![alt](../Photos/b.png)\n![](../Photos/a.jpg)";
    expect(photoEmbedRels(md)).toEqual(["../Photos/a.jpg", "../Photos/b.png"]);
  });

  it("skips an embed that already carries a markdown title (a user caption)", () => {
    const md = '![](../Photos/a.jpg "user title")\n![](../Photos/b.png)';
    expect(photoEmbedRels(md)).toEqual(["../Photos/b.png"]);
  });

  it("ignores external and non-Photos links", () => {
    const md =
      "![](https://example.com/x.png)\n[doc](../Files/spec.pdf)\n[audio](../Audio/clip.m4a)";
    expect(photoEmbedRels(md)).toEqual([]);
  });

  it("returns [] when there are no photo embeds", () => {
    expect(photoEmbedRels("# Title\n\njust prose")).toEqual([]);
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

describe("isSuspiciousBlanking", () => {
  it("flags an empty result on a non-empty note when the load was never confirmed", () => {
    expect(
      isSuspiciousBlanking({ original: "# Note\n\nbody", result: "", acked: false }),
    ).toBe(true);
  });

  it("treats a whitespace-only result as empty", () => {
    expect(isSuspiciousBlanking({ original: "body", result: "  \n ", acked: false })).toBe(true);
  });

  it("allows an empty result once the body was confirmed loaded (a genuine clear)", () => {
    expect(
      isSuspiciousBlanking({ original: "# Note\n\nbody", result: "", acked: true }),
    ).toBe(false);
  });

  it("does not flag a non-empty result", () => {
    expect(isSuspiciousBlanking({ original: "body", result: "edited", acked: false })).toBe(false);
  });

  it("does not flag when the note was already empty", () => {
    expect(isSuspiciousBlanking({ original: "   ", result: "", acked: false })).toBe(false);
  });
});

describe("round-trip (inject-then-swap)", () => {
  it("lists the images to swap, then restoring their swapped form returns the original", () => {
    const original =
      "# Note\n\n![](../Photos/a.jpg)\n\nsome prose\n\n![caption](../Photos/b.png)\n";
    expect(photoEmbedRels(original)).toEqual(["../Photos/a.jpg", "../Photos/b.png"]);
    // Simulate the editor after each image was swapped to a data URI (canonical
    // path kept in the title) and re-serialized on save.
    const swapped = original
      .replace("![](../Photos/a.jpg)", buildEditorImage("", DATA, "../Photos/a.jpg"))
      .replace(
        "![caption](../Photos/b.png)",
        buildEditorImage("caption", DATA, "../Photos/b.png"),
      );
    expect(restoreImagesFromEditor(swapped)).toBe(original);
  });

  it("a freshly inserted image round-trips to its canonical link", () => {
    // Insert path: editor receives buildEditorImage(...) directly (no swap pass).
    const inserted = buildEditorImage("", DATA, "../Photos/new.jpg");
    const body = `existing prose\n\n${inserted}`;
    expect(restoreImagesFromEditor(body)).toBe(
      "existing prose\n\n![](../Photos/new.jpg)",
    );
  });
});
