/**
 * Pure decision logic for the inline markdown image rule (see
 * ./markdownImageRule.tsx). Kept free of any `react-native` import so vitest can
 * unit-test it — RN's Flow source is unparseable by Rollup, so the JSX rule that
 * renders an <Image> lives in the sibling `.tsx` and is never pulled into a test.
 */

export type ImageSrcResolution =
  | { kind: "local"; uri: string }
  | { kind: "external"; uri: string }
  | { kind: "hidden" };

/**
 * Decide how a markdown image `src` should render, given the resolved
 * paired-image map (`rel → device URI`):
 *
 *   - a `src` that exactly matches a known paired rel → its resolved device URI
 *     (`{ kind: "local" }`);
 *   - an `http(s):` / `data:` `src` → rendered as-is (`{ kind: "external" }`);
 *   - anything else — an unresolved `../Photos/` rel (broken link) or a stray
 *     relative path the renderer couldn't load anyway → `{ kind: "hidden" }`.
 */
export function classifyImageSrc(
  src: string,
  uriByRel: ReadonlyMap<string, string>,
): ImageSrcResolution {
  const trimmed = src.trim();
  const direct = uriByRel.get(trimmed);
  if (direct) return { kind: "local", uri: direct };
  // markdown-it percent-encodes a link's src (normalizeLink), so a hand-authored
  // `../Photos/café.jpg` embed reaches us as `../Photos/caf%C3%A9.jpg` and won't
  // match the RAW rel keys (`listPairedBinaries`). Retry with a decoded form
  // before falling through — else the image would silently vanish (it's no longer
  // in the files-only Attachments card either).
  const decoded = safeDecodeURIComponent(trimmed);
  if (decoded !== trimmed) {
    const viaDecoded = uriByRel.get(decoded);
    if (viaDecoded) return { kind: "local", uri: viaDecoded };
  }
  if (/^(https?:|data:)/i.test(trimmed)) return { kind: "external", uri: trimmed };
  return { kind: "hidden" };
}

/** decodeURIComponent that returns the input unchanged on a malformed sequence
 * (a lone `%` throws) rather than letting it bubble through the renderer. */
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
