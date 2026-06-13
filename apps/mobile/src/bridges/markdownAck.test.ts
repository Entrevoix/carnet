import { describe, it, expect, vi } from 'vitest';
import { onceContentAck, resolveContentAck } from './markdownAck';

describe('content-ack (body-injection confirmation)', () => {
  it('fires the registered handler with the applied length', () => {
    const handler = vi.fn();
    onceContentAck(handler);
    resolveContentAck(42);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(42);
  });

  it('fires at most once — staircase re-send acks after the first are no-ops', () => {
    const handler = vi.fn();
    onceContentAck(handler);
    resolveContentAck(10);
    resolveContentAck(10); // a second ack from a re-sent setMarkdown
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the disposer clears the slot so a later ack is a harmless no-op', () => {
    const handler = vi.fn();
    const dispose = onceContentAck(handler);
    dispose();
    resolveContentAck(7);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the disposer only clears its own handler, not a newer registration', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const disposeStale = onceContentAck(stale);
    onceContentAck(fresh); // a new injection registered before the old disposer ran
    disposeStale(); // must NOT clear `fresh`
    resolveContentAck(5);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith(5);
  });

  it('resolve with no pending handler is a harmless no-op', () => {
    expect(() => resolveContentAck(1)).not.toThrow();
  });
});
