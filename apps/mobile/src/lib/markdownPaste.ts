/**
 * Decide what a paste into the WYSIWYG editor should do, kept as a pure function
 * so the branching is unit-testable without a live editor or WebView.
 *
 * Returns the markdown text to insert (parsed via insertContent with
 * contentType:'markdown'), or `null` to fall through to the editor's default
 * paste handler.
 *
 * Rule: a paste that carries rich content (text/html — from web pages, docs,
 * other editors) is left to the default handler so its formatting isn't mangled.
 * A plain-text-only paste is treated as raw markdown. Empty payloads no-op.
 *
 * @param html  the clipboard's `text/html` payload (`''` when absent)
 * @param text  the clipboard's `text/plain` payload (`''` when absent)
 */
export function markdownFromClipboard(html: string, text: string): string | null {
  if (html.trim()) return null;
  if (!text) return null;
  return text;
}
