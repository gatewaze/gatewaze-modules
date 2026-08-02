import { describe, it, expect } from 'vitest';
import { isNearBottom, PIN_THRESHOLD_PX } from '../components/autoscroll';

// The Runs-tab transcript "tails" the live stream while the user is near the bottom, and stops
// (remembering intent) once they scroll up. isNearBottom is the pure decision behind that memory;
// the DOM wiring (scroll listener, ResizeObserver, pin-to-bottom) is verified manually — jsdom
// reports scrollHeight/clientHeight as 0 and this module's vitest env is `node` anyway.
describe('isNearBottom', () => {
  it('is true exactly at the bottom', () => {
    // scrollTop maxed out: scrollHeight - scrollTop - clientHeight === 0.
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('is true within the threshold of the bottom', () => {
    // 1000 - 810 - 100 = 90 <= 120.
    expect(isNearBottom({ scrollTop: 810, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('is true at exactly the threshold distance (inclusive)', () => {
    // 1000 - 780 - 100 = 120 <= 120.
    expect(isNearBottom({ scrollTop: 780, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('is false when scrolled up beyond the threshold', () => {
    // 1000 - 500 - 100 = 400 > 120 → the user is reading scrollback.
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('is true for an empty / unscrollable container (content shorter than the viewport)', () => {
    // scrollHeight <= clientHeight: nothing to scroll, so tailing stays armed.
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });

  it('honours a custom threshold', () => {
    // 1000 - 950 - 100 = -50 (already past bottom): always near. And a tight threshold rejects slack.
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }, 10)).toBe(false);
    expect(isNearBottom({ scrollTop: 895, scrollHeight: 1000, clientHeight: 100 }, 10)).toBe(true);
  });

  it('defaults the threshold to PIN_THRESHOLD_PX', () => {
    const geo = { scrollTop: 780, scrollHeight: 1000, clientHeight: 100 };
    expect(isNearBottom(geo)).toBe(isNearBottom(geo, PIN_THRESHOLD_PX));
  });
});
