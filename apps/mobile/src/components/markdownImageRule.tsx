/**
 * Custom `image` render rule for react-native-markdown-display so a note's
 * inline `![](../Photos/x.jpg)` embeds render IN PLACE in the read-only detail
 * view — instead of being stripped out into a separate "Attachments" card,
 * divorced from where they sit in the prose.
 *
 * The markdown renderer can't resolve a vault-relative `../Photos/` link or a
 * SAF `content://` URI on its own, so the screen resolves each paired image to a
 * device-readable URI up front (in an effect) and hands us a `rel → uri` map.
 * This rule looks each embed's `src` up in that map and renders a native
 * <Image>; external `http(s)` / `data:` images render directly; an unresolved
 * paired embed (file moved or renamed externally — a broken link) renders
 * NOTHING rather than the renderer's broken-image box.
 *
 * Storage is unchanged: the `.md` keeps the tidy `![](../Photos/x.jpg)` link —
 * no base64 ever reaches disk (issue #43). This is display-only. The src→render
 * decision is the pure, unit-tested ./inlineImageSrc; this file is the thin JSX
 * wrapper (it imports `react-native`, so tests never touch it).
 */

import type { ReactNode } from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

import { classifyImageSrc } from "./inlineImageSrc";

/** The image-node shape we read. markdown-display passes more (children,
 * parent, styles, …) positionally; we only need the node's key, src, and alt.
 * markdown-it leaves `attributes.alt` empty and puts the alt text in the node's
 * `content`, so we read that first. */
interface ImageNode {
  key: string;
  content?: string;
  attributes?: { src?: string; alt?: string };
}

/**
 * Build the markdown-display `image` rule. `uriByRel` maps a note's paired image
 * embeds (`../Photos/x.jpg`) to resolved device URIs; `style` sizes the inline
 * image. The renderer invokes this for every image node in document order, so
 * each image lands exactly where it sits in the prose.
 */
export function makeImageRule(
  uriByRel: ReadonlyMap<string, string>,
  style: StyleProp<ImageStyle>,
): (node: ImageNode) => ReactNode {
  return function image(node: ImageNode): ReactNode {
    const src = node.attributes?.src ?? "";
    const alt = node.content || node.attributes?.alt || "";
    const res = classifyImageSrc(src, uriByRel);
    if (res.kind === "hidden") return null;
    return (
      <Image
        key={node.key}
        source={{ uri: res.uri }}
        style={style}
        resizeMode="contain"
        accessibilityLabel={alt || undefined}
      />
    );
  };
}
