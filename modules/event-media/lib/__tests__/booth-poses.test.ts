// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { BOOTH_POSES, boothPose, poseOfTheHour, poseChangesAt, fingerLook, fingerChoices } from '../booth-poses.js';
import { boothEffect, buildPrompt } from '../booth-effects.js';
import { BOOTH_ERAS } from '../booth-eras.js';

describe('the poses themselves', () => {
  it('are all readable in a booth and describable to a model', () => {
    expect(BOOTH_POSES.length).toBeGreaterThanOrEqual(12);
    const ids = BOOTH_POSES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BOOTH_POSES) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
      // Read at a glance, standing in a booth.
      expect(p.instruction.length).toBeLessThanOrEqual(64);
      expect(p.label.length).toBeLessThanOrEqual(24);
      expect(p.prompt.length).toBeGreaterThan(20);
      // The model is told what the pose is, not what to call it.
      expect(p.prompt).not.toMatch(/wedding|bride|groom/i);
    }
  });

  it('are looked up by id, and nothing else is', () => {
    expect(boothPose('huddle')?.label).toBe('The huddle');
    for (const bad of ['', 'nope', 42, null, undefined, {}]) expect(boothPose(bad)).toBeNull();
  });
});

describe('pose of the hour', () => {
  const at = (iso) => new Date(iso).getTime();

  it('is the same for everyone in a slot, and changes with it', () => {
    const a = poseOfTheHour(at('2026-09-25T19:05:00Z'), 30);
    const b = poseOfTheHour(at('2026-09-25T19:29:59Z'), 30);
    const c = poseOfTheHour(at('2026-09-25T19:31:00Z'), 30);
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
  });

  it('works through every pose before repeating one', () => {
    const start = at('2026-09-25T12:00:00Z');
    const seen = new Set();
    for (let i = 0; i < BOOTH_POSES.length; i++) seen.add(poseOfTheHour(start + i * 15 * 60_000, 15).id);
    expect(seen.size).toBe(BOOTH_POSES.length);
  });

  it('puts two events out of step with each other', () => {
    const t = at('2026-09-25T20:00:00Z');
    expect(poseOfTheHour(t, 30, 0).id).not.toBe(poseOfTheHour(t, 30, 3).id);
    // An offset past the end of the list still lands on a pose.
    expect(poseOfTheHour(t, 30, 999)).toBeTruthy();
    expect(poseOfTheHour(t, 30, -7)).toBeTruthy();
  });

  it('says when the pose changes next', () => {
    expect(poseChangesAt(at('2026-09-25T19:05:00Z'), 30).toISOString()).toBe('2026-09-25T19:30:00.000Z');
    expect(poseChangesAt(at('2026-09-25T19:59:00Z'), 60).toISOString()).toBe('2026-09-25T20:00:00.000Z');
  });

  it('never divides by a nonsense interval', () => {
    for (const bad of [0, -5, 0.2]) expect(poseOfTheHour(at('2026-09-25T20:00:00Z'), bad)).toBeTruthy();
  });
});

describe('fingers choose the look', () => {
  const looks = BOOTH_ERAS.find((e) => e.key === '1980s').looks;

  it('gives one look per finger, after the decade itself', () => {
    expect(looks).toHaveLength(6);
    expect(fingerLook(1, looks)).toBe(looks[1]);
    expect(fingerLook(5, looks)).toBe(looks[5]);
    expect(fingerChoices(looks.map((id) => ({ id })))).toHaveLength(5);
  });

  it('means "keep what they picked" for no fingers or an unreadable hand', () => {
    for (const n of [0, 6, -1, 1.5, NaN]) expect(fingerLook(n, looks)).toBeNull();
  });
});

describe('a pose in the prompt', () => {
  const effect = boothEffect('top-gun');

  it('is stated before and after the style, and forbids tidying up', () => {
    const p = buildPrompt(effect, 'standing back to back with arms folded');
    expect(p.match(/standing back to back/g)).toHaveLength(2);
    expect(p).toMatch(/do not rearrange them/i);
    expect(p).toMatch(/do not turn them to face the camera/i);
    // Still the whole rest of the prompt.
    expect(p).toContain(effect.style);
    expect(p).toMatch(/proportion/i);
  });

  it('leaves the prompt exactly as it was when there is no pose', () => {
    expect(buildPrompt(effect)).toBe(buildPrompt(effect, null));
    expect(buildPrompt(effect)).not.toMatch(/This pose is the subject/);
  });
});

import { READY_PROMPTS, readyPrompt, readyWindow, READY_OPENS_MS } from '../ready-prompts.js';

describe('the morning before', () => {
  const start = Date.parse('2026-09-25T13:30:00Z');

  it('opens a day and a half out and closes when the event starts', () => {
    expect(readyWindow(new Date(start).toISOString(), start - 60 * 60_000).active).toBe(true);
    expect(readyWindow(new Date(start).toISOString(), start - READY_OPENS_MS + 1000).active).toBe(true);
    // Too early, and once it has begun.
    expect(readyWindow(new Date(start).toISOString(), start - READY_OPENS_MS - 1000).active).toBe(false);
    expect(readyWindow(new Date(start).toISOString(), start + 1000).active).toBe(false);
  });

  it('is simply off when the event has no start time', () => {
    for (const bad of [null, undefined, '', 'soon']) {
      expect(readyWindow(bad, Date.now())).toEqual({ active: false, starts_at: null, until: null });
    }
  });

  it('asks for things anyone can photograph alone, and points the right camera', () => {
    expect(READY_PROMPTS.length).toBeGreaterThanOrEqual(8);
    for (const p of READY_PROMPTS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]{1,20}$/);
      expect(p.label.length).toBeLessThanOrEqual(20);
      expect(p.blurb.length).toBeLessThanOrEqual(56);
      expect(['user', 'environment']).toContain(p.camera);
    }
    // A face wants the front camera; shoes want the back one.
    expect(readyPrompt('mirror').camera).toBe('user');
    expect(readyPrompt('shoes').camera).toBe('environment');
    expect(readyPrompt('nope')).toBeNull();
  });
});
