/**
 * RN-side resolver for the single in-flight requestMarkdown() reply. Extracted
 * from MarkdownBridge so the timeout/cleanup logic is unit-testable without
 * importing the TenTap (react-native) bridge surface, which can't load headless.
 *
 * Save-on-demand issues one requestMarkdown() at a time, so a single pending
 * resolver suffices; an overlapping second request would drop the first.
 */
let pendingResolve: ((markdown: string) => void) | null = null;

/**
 * Call immediately before editor.requestMarkdown(); resolves when the WebView
 * replies (via resolveMarkdownResponse). Rejects — and clears the module-level
 * resolver slot — after `timeoutMs` so a never-arriving reply (Save tapped before
 * the editor mounted, a wedged WebView) can't leave `pendingResolve` dangling.
 * Without this, the abandoned resolver would sit until the next request
 * overwrote it, and a late reply could fire a stale resolve.
 */
export function awaitMarkdownResponse(timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const settle = (markdown: string) => {
      clearTimeout(timer);
      if (pendingResolve === settle) pendingResolve = null;
      resolve(markdown);
    };
    timer = setTimeout(() => {
      if (pendingResolve === settle) pendingResolve = null;
      reject(new Error('Editor timed out — try again.'));
    }, timeoutMs);
    pendingResolve = settle;
  });
}

/** Resolve the in-flight awaitMarkdownResponse() with the WebView's reply (no-op if none pending). */
export function resolveMarkdownResponse(markdown: string): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.(markdown);
}
