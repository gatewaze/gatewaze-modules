import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEED, FRAME_PAGE, SPEEDS, frameMs, frameUrl, frameWidth, keepWindow, lookahead, pageStart, playLength, speedOf,
} from '../event-pages/_components/_lib/slideshow';

describe('the speed', () => {
  it('offers the speeds asked for, two and three a second among them', () => {
    expect(SPEEDS).toContain(2);
    expect(SPEEDS).toContain(3);
  });

  it('takes only a speed it offers', () => {
    expect(speedOf(3)).toBe(3);
    expect(speedOf('5')).toBe(5);
    expect(speedOf(4)).toBe(DEFAULT_SPEED);
    expect(speedOf('fast')).toBe(DEFAULT_SPEED);
    expect(speedOf(undefined)).toBe(DEFAULT_SPEED);
  });

  it('holds each frame for its share of a second', () => {
    expect(frameMs(2)).toBe(500);
    expect(frameMs(3)).toBe(333);
  });
});

describe('the size of a frame', () => {
  it('sizes by the shorter side of the screen', () => {
    // A phone held upright: as wide as the phone, at twice its pixels.
    expect(frameWidth(390, 844, 3)).toBe(960);
    // A 1080p screen: a portrait photograph is 1080 tall, under 1000 wide.
    expect(frameWidth(1920, 1080, 1)).toBe(960);
    expect(frameWidth(640, 480, 1)).toBe(640);
    expect(frameWidth(1440, 900, 2)).toBe(1280);
  });

  it('never asks for more than 1280, whatever the screen', () => {
    expect(frameWidth(5120, 2880, 2)).toBe(1280);
  });

  it('survives a nonsense pixel ratio', () => {
    expect(frameWidth(800, 600, NaN)).toBe(640);
    expect(frameWidth(800, 600, 0)).toBe(640);
  });

  it('asks the CDN for that width at a frame\'s quality', () => {
    expect(frameUrl('https://zone.b-cdn.net/x.jpg', 960)).toBe('https://zone.b-cdn.net/x.jpg?width=960&quality=70');
    expect(frameUrl('https://zone.b-cdn.net/x.jpg?width=800', 960)).toBe('https://zone.b-cdn.net/x.jpg?width=800');
  });
});

describe('finding a frame', () => {
  it('knows which page of the gallery holds it', () => {
    expect(pageStart(0)).toBe(0);
    expect(pageStart(FRAME_PAGE - 1)).toBe(0);
    expect(pageStart(FRAME_PAGE)).toBe(FRAME_PAGE);
    // Past the old 2000 ceiling: a full delivery is 4,600.
    expect(pageStart(4599)).toBe(4400);
    expect(pageStart(-3)).toBe(0);
  });

  it('keeps three seconds ahead loaded, and at least six frames', () => {
    expect(lookahead(1)).toBe(6);
    expect(lookahead(3)).toBe(9);
    expect(lookahead(5)).toBe(15);
  });

  it('keeps one frame behind and the lookahead in front, inside the album', () => {
    expect(keepWindow(10, 3, 4600)).toEqual({ from: 9, to: 19 });
    expect(keepWindow(0, 2, 4600)).toEqual({ from: 0, to: 6 });
    expect(keepWindow(4598, 5, 4600)).toEqual({ from: 4597, to: 4599 });
    expect(keepWindow(0, 2, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('how long it plays', () => {
  it('says minutes and seconds', () => {
    expect(playLength(4600, 3)).toBe('25:33');
    expect(playLength(120, 2)).toBe('1:00');
    expect(playLength(0, 2)).toBe('0:00');
  });
});
