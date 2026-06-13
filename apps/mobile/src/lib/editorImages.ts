/**
 * Image-link resolution for the WYSIWYG (TenTap) editor.
 *
 * The editor WebView loads at `https://localhost/`, so a note's relative
 * `![](../Photos/x.jpg)` embed can't resolve to the on-disk file, and
 * @tiptap/markdown's getMarkdown() serializes whatever `src` the image node
 * holds — so we also can't just point the src at the file: a `data:` URI left
 * in the node would be written straight back into the `.md`, replacing the tidy
 * relative link with a multi-megabyte base64 blob and corrupting the note.
 *
 * Strategy (the corruption-prone string surgery is pure + unit-testable here):
 *   - On the way IN we inject the body with its CANONICAL `../Photos/...` links
 *     untouched (a small, reliable setMarkdown), then swap each image to a `data:`
 *     URI one bridge message at a time (see set-image-src in MarkdownBridge). The
 *     swap sets the node's display src to the data URI AND stashes the canonical
 *     relative path in the image *title* slot:
 *       ![](../Photos/x.jpg)  →  ![](data:image/jpeg;base64,… "../Photos/x.jpg")
 *     Injecting canonical-first means no single message ever carries the whole
 *     note's worth of base64 — the failure mode that opened the editor BLANK when
 *     every image was folded into one setMarkdown string (issue #43).
 *   - On the way OUT (after getMarkdown), rebuild the canonical `![alt](rel)`
 *     embed from the title and DISCARD the returned src entirely. Because we
 *     never trust the (huge) data URI that comes back, it doesn't matter whether
 *     the editor's markdown serializer preserved it byte-for-byte — only the
 *     short alt + title need to survive the round-trip. An image whose swap never
 *     landed (resolver returned null, message dropped) stays canonical: it shows
 *     broken in-editor but saves + renders fine — never corrupt.
 *
 * A new insert reuses the same shape: the picker hands us the bytes, we build
 * `![](data:… "../Photos/new.jpg")`, and the OUT pass restores the relative link.
 *
 * Only `../Photos/` embeds are touched. External images (`![](https://…)`) load
 * natively in the WebView and are left alone; `../Files/` / `../Audio/` links are
 * not image embeds and never match.
 */

/** Hard cap on the base64 length we'll hand the editor as a `data:` URI for a
 * SINGLE image. A larger image still writes to disk and embeds correctly — it
 * just won't preview in-editor.
 *
 * This now bounds ONE per-image bridge message (a set-image-src swap, or a fresh
 * insertMarkdown), NOT the whole-note injection: the body is injected with
 * canonical links first, then each image is swapped in via its own message, so a
 * note with many images no longer compounds into one oversized payload. That
 * compounding is what silently failed to apply on-device (2026-06-12, Pixel 9 Pro
 * Fold) and opened the editor BLANK when the cap was raised to 24 MB under the old
 * single-setMarkdown scheme (issue #43). With inject-then-swap a too-large swap
 * degrades gracefully (image stays canonical, editor is never blank, save is
 * safe), so the cap can sit well above the old 8 MB. Tune on-device if needed. */
export const MAX_EDITOR_IMAGE_BASE64 = 16 * 1024 * 1024; // ~12 MB of binary

/** Canonical `../Photos/<file>` embed as carnet writes it, with an optional
 * pre-existing markdown title we must not clobber. */
const PHOTO_EMBED =
  /!\[([^\]]*)\]\(\s*(\.\.\/Photos\/[^)"\s]+)\s*(?:"([^"]*)")?\s*\)/g;

/** An editor-side embed whose title carries a `../Photos/...` path — our marker.
 * The src (`[^")]*`) is whatever the editor serialized (a data URI, possibly
 * mangled); we capture and discard it, rebuilding from the title alone. */
const TITLE_CARRIED =
  /!\[([^\]]*)\]\(\s*[^")]*\s*"(\.\.\/Photos\/[^"]+)"\s*\)/g;

/** A `data:` embed that came back WITHOUT our title marker — the failure mode
 * where the serializer dropped the title. Never written back verbatim. */
const DATA_EMBED_NO_TITLE = /!\[([^\]]*)\]\(\s*(data:[^)"\s]+)\s*\)/g;

/** Final backstop: ANY image embed whose URL still contains a `data:<type>/…`
 * URI after the two recovery passes. Tolerant of an alt with `]` (lazy `[^\n]*?`
 * backtracks past it) and of whitespace/newlines inside the payload (`[^)]`), so
 * no hostile/mangled embed can smuggle a base64 blob onto disk. Anchored on
 * `data:<letters>/` (a real MIME) so a literal `data:` in a file path can't trip
 * it. This makes "a saved body never contains a data URI" an enforced
 * postcondition rather than an emergent property of the two passes above. */
const RESIDUAL_DATA_EMBED = /!\[[^\n]*?\]\([^)]*?data:[a-z]+\/[^)]*?\)/g;

/** `data:<mime>;base64,<payload>` for inline rendering. */
export function toDataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Editor-side embed: data URI src for display, relative path in the title. */
export function buildEditorImage(alt: string, dataUri: string, rel: string): string {
  return `![${alt}](${dataUri} "${rel}")`;
}

/** Canonical on-disk embed: just the relative path. */
export function buildCanonicalImage(alt: string, rel: string): string {
  return `![${alt}](${rel})`;
}

/**
 * The unique `../Photos/...` embed paths to swap to data URIs after the canonical
 * body is injected, in document order, deduped. Embeds that already carry a
 * markdown title (a user caption) are skipped — left canonical, as before, since
 * the title slot is how we round-trip the canonical path and we won't clobber a
 * real caption. Non-`../Photos/` links never match.
 */
export function photoEmbedRels(markdown: string): string[] {
  const rels: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(PHOTO_EMBED)) {
    if (m[3]) continue; // pre-existing title — leave canonical (no preview)
    const rel = m[2];
    if (seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
  }
  return rels;
}

/**
 * Inverse of the in-editor swap: turn editor-side embeds back into canonical
 * `![alt](../Photos/...)` links so the saved `.md` never contains a data URI.
 *
 *   1. Title-carried embeds → rebuilt from the title, src discarded. This is the
 *      normal path and is immune to the data URI being re-encoded by the editor.
 *   2. Any leftover `data:` embed that lost its title is a corruption risk — it
 *      is mapped back via `knownImages` (exact data-URI → rel) when possible, and
 *      otherwise DROPPED. Losing an embed (the file is still in Photos/, re-
 *      insertable) is strictly safer than writing a base64 blob into a synced note.
 *   3. A final catch-all drops ANY image embed that STILL carries a `data:` URI —
 *      the backstop that makes "no base64 blob ever reaches disk" hold even if a
 *      serializer escaped the title, mangled the src, or emitted a hostile alt.
 *
 * The passes run in order: title recovery must precede the no-title sweep (so a
 * recoverable embed isn't dropped), which precedes the catch-all (which only sees
 * genuinely unrecoverable blobs). Non-image text, external images, and already-
 * canonical `../Photos/` links pass through unchanged, so the transform is
 * idempotent on a clean on-disk body.
 */
export function restoreImagesFromEditor(
  markdown: string,
  knownImages?: ReadonlyMap<string, string>,
): string {
  const fromTitles = markdown.replace(
    TITLE_CARRIED,
    (_whole, alt: string, rel: string) => buildCanonicalImage(alt, rel),
  );
  const remapped = fromTitles.replace(
    DATA_EMBED_NO_TITLE,
    (_whole, alt: string, src: string) => {
      const rel = knownImages?.get(src);
      return rel ? buildCanonicalImage(alt, rel) : "";
    },
  );
  // Postcondition guard: nothing below this line may contain a data URI.
  return remapped.replace(RESIDUAL_DATA_EMBED, "");
}

/**
 * Guard against a silently-failed injection blanking a note on Save.
 *
 * If the body injection's bridge message is dropped (the issue-#43 failure: an
 * oversized payload never reaches the WebView), the editor sits empty, getMarkdown
 * reads back nothing, and the caller's `next === body` short-circuit doesn't fire
 * — so a Save would overwrite the note with an empty body. Returns true for that
 * shape: the note HAD content, the editor returned none, and we never got a
 * content-ack confirming the body actually loaded.
 *
 * An ack-confirmed empty result is a genuine user clear (they saw the content and
 * deleted it) and returns false — only the unconfirmed case is treated as unsafe.
 */
export function isSuspiciousBlanking(opts: {
  original: string;
  result: string;
  acked: boolean;
}): boolean {
  return !opts.acked && opts.original.trim() !== "" && opts.result.trim() === "";
}
