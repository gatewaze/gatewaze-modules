/**
 * Overview's Realtime backstop poll. Fits the module's node vitest config
 * (`environment: 'node'`, no jsdom) — a minimal doc double stands in for `document`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startVisibilityPoll } from '../../admin/lib/visibility-poll';

// Minimal `document`-shaped double: tracks its one visibilitychange listener and lets the test
// flip `hidden` and fire the event, without pulling in jsdom.
function fakeDoc(initialHidden = false) {
  let listener: (() => void) | undefined;
  return {
    hidden: initialHidden,
    addEventListener(_type: 'visibilitychange', fn: () => void) { listener = fn; },
    removeEventListener(_type: 'visibilitychange', fn: () => void) { if (listener === fn) listener = undefined; },
    fireVisibilityChange() { listener?.(); },
    hasListener() { return listener !== undefined; },
  };
}

describe('startVisibilityPoll', () => {
  afterEach(() => vi.useRealTimers());

  it('calls load on the given interval while visible', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const stop = startVisibilityPoll(load, 20000, fakeDoc(false));

    vi.advanceTimersByTime(19999);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20000);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
  });

  it('does not call load on interval ticks while hidden', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const doc = fakeDoc(true);
    const stop = startVisibilityPoll(load, 20000, doc);

    vi.advanceTimersByTime(60000);
    expect(load).not.toHaveBeenCalled();

    stop();
  });

  it('calls load immediately when visibilitychange fires while visible', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const doc = fakeDoc(false);
    const stop = startVisibilityPoll(load, 20000, doc);

    doc.fireVisibilityChange();
    expect(load).toHaveBeenCalledTimes(1);

    stop();
  });

  it('does not call load on visibilitychange while still hidden', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const doc = fakeDoc(true);
    const stop = startVisibilityPoll(load, 20000, doc);

    doc.fireVisibilityChange();
    expect(load).not.toHaveBeenCalled();

    stop();
  });

  it('stops both the interval and the visibilitychange listener on cleanup', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const doc = fakeDoc(false);
    const stop = startVisibilityPoll(load, 20000, doc);
    expect(doc.hasListener()).toBe(true);

    stop();
    expect(doc.hasListener()).toBe(false);

    vi.advanceTimersByTime(60000);
    doc.fireVisibilityChange();
    expect(load).not.toHaveBeenCalled();
  });
});
