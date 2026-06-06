/**
 * Pure selection-aware markdown edit transforms for the RecentDetail edit-mode
 * toolbar. Each helper takes the current text + selection and returns BOTH the
 * new text and the new selection, so the caller can re-set the TextInput's
 * selection (cursor placement is the main UX failure mode of these toolbars).
 *
 * No I/O, no React — mirrors the codebase's other pure markdown helpers
 * (`injectImageEmbed`, `upsertSection`, `slugify` in writer.ts). All returns
 * are fresh objects; inputs are never mutated.
 */

export interface Sel {
  start: number;
  end: number;
}

export interface EditResult {
  text: string;
  selection: Sel;
}

/** Formatting intents the toolbar can emit (image is handled separately, since
 * it needs an async picker + binary write). */
export type FormatKind =
  | "bold"
  | "italic"
  | "code"
  | "h1"
  | "h2"
  | "bullet"
  | "ordered"
  | "checkbox"
  | "link";

/** Normalize a selection so start <= end (RN usually guarantees this, but the
 * helpers stay correct even if a caller hands them a reversed range). */
function norm(sel: Sel): Sel {
  return sel.start <= sel.end
    ? { start: sel.start, end: sel.end }
    : { start: sel.end, end: sel.start };
}

/**
 * Wrap the selection with `marker` (e.g. `**`, `*`, `` ` ``), toggling:
 *   - empty selection → insert `marker+marker`, cursor between (or, if the
 *     cursor already sits between an empty pair, collapse it).
 *   - selection that already includes the markers (`**x**`) → strip them.
 *   - selection whose immediate neighbours are the markers → unwrap them.
 *   - otherwise → wrap, leaving the original content selected.
 */
export function wrapSelection(
  text: string,
  selection: Sel,
  marker: string,
): EditResult {
  const { start, end } = norm(selection);
  const len = marker.length;

  if (start === end) {
    // Cursor between an existing empty pair (`**|**`) → remove it.
    if (
      start >= len &&
      text.slice(start - len, start) === marker &&
      text.slice(start, start + len) === marker
    ) {
      return {
        text: text.slice(0, start - len) + text.slice(start + len),
        selection: { start: start - len, end: start - len },
      };
    }
    // Otherwise insert an empty pair and place the cursor between the markers.
    return {
      text: text.slice(0, start) + marker + marker + text.slice(start),
      selection: { start: start + len, end: start + len },
    };
  }

  const selected = text.slice(start, end);

  // Markers captured inside the selection (`**x**`) → strip them. Require at
  // least one inner char (`> 2*len`, not `>=`) so a selection of bare markers
  // like `**` doesn't get read as an empty wrapped pair and deleted when a
  // DIFFERENT marker (e.g. italic `*`) is applied.
  if (
    selected.length > 2 * len &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(len, selected.length - len);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selection: { start, end: start + inner.length },
    };
  }

  // Markers just outside the selection → unwrap them.
  if (
    start >= len &&
    text.slice(start - len, start) === marker &&
    text.slice(end, end + len) === marker
  ) {
    return {
      text: text.slice(0, start - len) + selected + text.slice(end + len),
      selection: { start: start - len, end: end - len },
    };
  }

  // Plain wrap — keep the original content selected (shifted past the marker).
  return {
    text: text.slice(0, start) + marker + selected + marker + text.slice(end),
    selection: { start: start + len, end: end + len },
  };
}

/**
 * Prefix every line overlapping the selection with `prefix`. Handles three
 * families, each toggling when all selected lines already carry it:
 *   - heading (`# ` / `## `): replaces any existing heading level, or strips it.
 *   - ordered (`1. `): renumbers selected non-empty lines 1., 2., 3., …
 *   - simple (`- `, `- [ ] `): prepends to each non-empty line.
 *
 * Returns the modified block fully selected so a second tap toggles it back.
 */
export function prefixLines(
  text: string,
  selection: Sel,
  prefix: string,
): EditResult {
  const { start, end } = norm(selection);

  const blockStart = text.lastIndexOf("\n", start - 1) + 1;
  // If the selection ends exactly at the start of a line (its last char is the
  // preceding newline), that next line isn't really selected — don't prefix it.
  const lookupEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nlAfter = text.indexOf("\n", lookupEnd);
  const blockEnd = nlAfter === -1 ? text.length : nlAfter;
  const block = text.slice(blockStart, blockEnd);
  const lines = block.split("\n");

  const isHeading = /^#{1,6} $/.test(prefix);
  const isOrdered = /^\d+\.\s$/.test(prefix);
  const nonEmpty = lines.filter((l) => l.trim() !== "");

  let newLines: string[];
  if (isHeading) {
    const allHave = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));
    newLines = lines.map((line) => {
      const stripped = line.replace(/^#{1,6} /, "");
      if (line.trim() === "") return line;
      return allHave ? stripped : prefix + stripped;
    });
  } else if (isOrdered) {
    const ordered = /^\d+\.\s/;
    const allHave = nonEmpty.length > 0 && nonEmpty.every((l) => ordered.test(l));
    let n = 0;
    newLines = lines.map((line) => {
      if (line.trim() === "") return line;
      const stripped = line.replace(ordered, "");
      if (allHave) return stripped;
      n += 1;
      return `${n}. ${stripped}`;
    });
  } else {
    const allHave = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));
    newLines = lines.map((line) => {
      if (line.trim() === "") return line;
      if (allHave) return line.slice(prefix.length);
      return line.startsWith(prefix) ? line : prefix + line;
    });
  }

  const newBlock = newLines.join("\n");
  return {
    text: text.slice(0, blockStart) + newBlock + text.slice(blockEnd),
    selection: { start: blockStart, end: blockStart + newBlock.length },
  };
}

/**
 * Replace the selection with `snippet`. `cursor` positions the resulting
 * selection relative to the start of the inserted snippet: a number collapses
 * the cursor there; a range selects within the snippet; omitted places the
 * cursor right after the snippet.
 */
export function insertAtCursor(
  text: string,
  selection: Sel,
  snippet: string,
  cursor?: number | { start: number; end: number },
): EditResult {
  const { start, end } = norm(selection);
  const newText = text.slice(0, start) + snippet + text.slice(end);

  let sel: Sel;
  if (cursor == null) {
    sel = { start: start + snippet.length, end: start + snippet.length };
  } else if (typeof cursor === "number") {
    sel = { start: start + cursor, end: start + cursor };
  } else {
    sel = { start: start + cursor.start, end: start + cursor.end };
  }
  return { text: newText, selection: sel };
}

/**
 * Map a toolbar formatting intent to the right transform. Centralized + pure so
 * the screen just does `setDraft(r.text); setSelection(r.selection)` and the
 * mapping (including the link snippet + cursor placement) is unit-tested.
 */
export function applyFormat(
  text: string,
  selection: Sel,
  kind: FormatKind,
): EditResult {
  switch (kind) {
    case "bold":
      return wrapSelection(text, selection, "**");
    case "italic":
      return wrapSelection(text, selection, "*");
    case "code":
      return wrapSelection(text, selection, "`");
    case "h1":
      return prefixLines(text, selection, "# ");
    case "h2":
      return prefixLines(text, selection, "## ");
    case "bullet":
      return prefixLines(text, selection, "- ");
    case "ordered":
      return prefixLines(text, selection, "1. ");
    case "checkbox":
      return prefixLines(text, selection, "- [ ] ");
    case "link": {
      const { start, end } = norm(selection);
      const selected = text.slice(start, end);
      const linkText = selected || "text";
      const snippet = `[${linkText}](url)`;
      // Select the placeholder "url" so the user can type the address over it.
      const urlStart = linkText.length + 3; // past `[linkText](`
      return insertAtCursor(text, selection, snippet, {
        start: urlStart,
        end: urlStart + 3,
      });
    }
  }
}
