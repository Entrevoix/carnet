import { describe, it, expect } from 'vitest';
import { markdownFromClipboard } from './markdownPaste';

describe('markdownFromClipboard (WYSIWYG paste branching)', () => {
  it('returns the plain text (to parse as markdown) when there is no HTML payload', () => {
    expect(markdownFromClipboard('', '## Hi\n\n- a\n- b')).toBe('## Hi\n\n- a\n- b');
  });

  it('falls through (null) when the clipboard carries rich HTML, to keep formatting', () => {
    expect(markdownFromClipboard('<b>hi</b>', '**hi**')).toBeNull();
  });

  it('treats whitespace-only HTML as no HTML and still parses the plain text', () => {
    expect(markdownFromClipboard('   \n  ', 'plain text')).toBe('plain text');
  });

  it('no-ops (null) on an empty clipboard', () => {
    expect(markdownFromClipboard('', '')).toBeNull();
  });

  it('no-ops (null) when only HTML is present (no plain text fallback)', () => {
    expect(markdownFromClipboard('<p>x</p>', '')).toBeNull();
  });
});
