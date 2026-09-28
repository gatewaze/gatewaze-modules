import { describe, it, expect } from 'vitest';
import { dragOffset, swipeVerdict, TAP_SLOP_PX } from '../event-pages/_components/_lib/swipe';

const W = 400;

describe('when a finger lifts', () => {
  it('brings in the next when the photograph is dragged well left', () => {
    expect(swipeVerdict({ dx: -200, ms: 600, width: W })).toBe('next');
    expect(swipeVerdict({ dx: 200, ms: 600, width: W })).toBe('previous');
  });

  it('springs back when it barely moved', () => {
    expect(swipeVerdict({ dx: -40, ms: 600, width: W })).toBe('stay');
    expect(swipeVerdict({ dx: 0, ms: 100, width: W })).toBe('stay');
  });

  // A flick is short and fast: the photograph should still go.
  it('takes a flick, however short', () => {
    expect(swipeVerdict({ dx: -60, ms: 80, width: W })).toBe('next');
    expect(swipeVerdict({ dx: 60, ms: 80, width: W })).toBe('previous');
    // ...but not a twitch.
    expect(swipeVerdict({ dx: -20, ms: 30, width: W })).toBe('stay');
  });

  it('is not fooled by nonsense', () => {
    expect(swipeVerdict({ dx: NaN, ms: 100, width: W })).toBe('stay');
    expect(swipeVerdict({ dx: -300, ms: 100, width: 0 })).toBe('stay');
  });
});

describe('how far the photograph follows', () => {
  it('follows the finger exactly in the middle of an album', () => {
    expect(dragOffset(-120, { atStart: false, atEnd: false })).toBe(-120);
  });

  // At the ends there is nothing to bring in, so it resists.
  it('resists at the first photograph and the last', () => {
    expect(dragOffset(120, { atStart: true, atEnd: false })).toBe(30);
    expect(dragOffset(-120, { atStart: false, atEnd: true })).toBe(-30);
    // Dragging the other way at an end is a normal drag.
    expect(dragOffset(-120, { atStart: true, atEnd: false })).toBe(-120);
  });

  it('has a tap slop small enough to be a tap', () => {
    expect(TAP_SLOP_PX).toBeLessThanOrEqual(12);
    expect(dragOffset(NaN, { atStart: false, atEnd: false })).toBe(0);
  });
});
