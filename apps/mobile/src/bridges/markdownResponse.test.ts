import { describe, it, expect } from 'vitest';
import { awaitMarkdownResponse, resolveMarkdownResponse } from './markdownResponse';

describe('awaitMarkdownResponse (save-path bridge resolver)', () => {
  it('resolves with the WebView reply when it arrives in time', async () => {
    const pending = awaitMarkdownResponse(1000);
    resolveMarkdownResponse('# edited body');
    await expect(pending).resolves.toBe('# edited body');
  });

  it('rejects after the timeout when no reply arrives', async () => {
    await expect(awaitMarkdownResponse(10)).rejects.toThrow(/timed out/i);
  });

  it('clears the resolver on timeout so a late reply is a harmless no-op', async () => {
    await expect(awaitMarkdownResponse(10)).rejects.toThrow();
    // The slot must be empty now — a stray late reply must not throw or leak.
    expect(() => resolveMarkdownResponse('late reply')).not.toThrow();
  });

  it('a fresh request after a timeout still works (no stuck state)', async () => {
    await expect(awaitMarkdownResponse(10)).rejects.toThrow();
    const pending = awaitMarkdownResponse(1000);
    resolveMarkdownResponse('# recovered');
    await expect(pending).resolves.toBe('# recovered');
  });
});
