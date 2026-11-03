import { describe, it, expect } from 'vitest';
import { dragOffset, GUTTER_PX, settleOffset, swipeVerdict, TAP_SLOP_PX } from '../event-pages/_components/_lib/swipe';

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

describe('settling onto the next photograph', () => {
  // The neighbours sit one full width plus the gutter to either side.
  // Travelling any other distance leaves the incoming photograph off
  // centre, and the correction back to the middle is the "bounce" a
  // swipe used to end with.
  it('travels exactly to where the neighbour is', () => {
    expect(settleOffset(-1, 800)).toBe(-(800 + GUTTER_PX));
    expect(settleOffset(1, 800)).toBe(800 + GUTTER_PX);
  });

  it('is the width of the roll, not of the window', () => {
    // A narrow track inside a wide window: the old code used the window
    // and overshot by the difference.
    expect(settleOffset(-1, 400)).toBe(-(400 + GUTTER_PX));
    expect(settleOffset(-1, 400)).not.toBe(-1400);
  });

  it('refuses to move on a width it cannot believe', () => {
    expect(settleOffset(-1, 0)).toBe(0);
    expect(settleOffset(1, NaN)).toBe(0);
    expect(settleOffset(1, -10)).toBe(0);
  });

  it('takes a gutter of its own, and nothing silly', () => {
    expect(settleOffset(-1, 100, 0)).toBe(-100);
    expect(settleOffset(-1, 100, -5)).toBe(-100);
    expect(settleOffset(-1, 100, NaN)).toBe(-(100 + GUTTER_PX));
  });
});
