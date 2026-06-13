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
 * Strategy (all on the RN side, so the corruption-prone part is pure + unit-
 * testable):
 *   - On the way IN (before setMarkdown), swap each `../Photos/...` embed for a
 *     `data:` URI — which renders origin-independently inside the WebView — and
 *     stash the canonical relative path in the image *title* slot:
 *       ![](../Photos/x.jpg)  →  ![](data:image/jpeg;base64,… "../Photos/x.jpg")
 *   - On the way OUT (after getMarkdown), rebuild the canonical `![alt](rel)`
 *     embed from the title and DISCARD the returned src entirely. Because we
 *     never trust the (huge) data URI that comes back, it doesn't matter whether
 *     the editor's markdown serializer preserved it byte-for-byte — only the
 *     short alt + title need to survive the round-trip.
 *
 * A new insert reuses the same shape: the picker hands us the bytes, we build
 * `![](data:… "../Photos/new.jpg")`, and the OUT pass restores the relative link.
 *
 * Only `../Photos/` embeds are touched. External images (`![](https://…)`) load
 * natively in the WebView and are left alone; `../Files/` / `../Audio/` links are
 * not image embeds and never match.
 */

/** Hard cap on the base64 length we'll inline as a `data:` URI. A larger image
 * still writes to disk and embeds correctly — it just won't preview in-editor
 * (rather than bloating the DOM + the bridge message with megabytes of base64).
 *
 * Sized to cover full-resolution phone photos (a Pixel JPEG is ~2–12 MB) while
 * staying well under the 200 MB share/OOM cap (MAX_SAFE_SHARE_BYTES) — that
 * ceiling is fine on disk but would be ruinous inlined into the WebView. The
 * resolve pass inlines every Photos embed of a note into one setMarkdown call,
 * so this is a per-image bound; a note with a handful of images stays within a
 * sane total bridge payload. */
export const MAX_EDITOR_IMAGE_BASE64 = 24 * 1024 * 1024; // ~17 MB of binary

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

async function safeResolve(
  resolve: (rel: string) => Promise<string | null>,
  rel: string,
): Promise<string | null> {
  try {
    return await resolve(rel);
  } catch {
    return null;
  }
}

/**
 * Rewrite every `../Photos/...` embed to an editor-displayable form. `resolve`
 * maps a relative path to a `data:` URI (or null when the file is missing or too
 * large to inline); each unique path is resolved once. Embeds that already carry
 * a markdown title, that resolve to null, or that aren't `../Photos/` links are
 * left untouched (they stay canonical — at worst a missing image shows broken,
 * never corrupt).
 */
export async function resolveImagesForEditor(
  markdown: string,
  resolve: (rel: string) => Promise<string | null>,
): Promise<string> {
  const rels = new Set<string>();
  for (const m of markdown.matchAll(PHOTO_EMBED)) {
    if (m[3]) continue; // pre-existing title — don't touch
    rels.add(m[2]);
  }
  if (rels.size === 0) return markdown;

  const resolved = new Map<string, string | null>();
  await Promise.all(
    [...rels].map(async (rel) => {
      resolved.set(rel, await safeResolve(resolve, rel));
    }),
  );

  return markdown.replace(PHOTO_EMBED, (whole, alt: string, rel: string, title?: string) => {
    if (title) return whole;
    const dataUri = resolved.get(rel);
    if (!dataUri) return whole;
    return buildEditorImage(alt, dataUri, rel);
  });
}

/**
 * Inverse of resolveImagesForEditor: turn editor-side embeds back into canonical
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
