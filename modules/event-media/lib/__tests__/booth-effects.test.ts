// @ts-nocheck — vitest harness.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BOOTH_EFFECTS, boothEffect, buildPrompt, publicEffects } from '../booth-effects.js';
import { boothStatus, styleConfigured, swapConfigured } from '../booth-provider.js';

describe('boothEffect', () => {
  it('resolves a known effect', () => {
    expect(boothEffect('top-gun')?.kind).toBe('style');
  });
  it('rejects anything not in the catalogue', () => {
    // The id reaches a paid GPU call, so an unknown one must not fall
    // through to a default effect.
    expect(boothEffect('nope')).toBeNull();
    expect(boothEffect('')).toBeNull();
    expect(boothEffect('__proto__')).toBeNull();
    expect(boothEffect('constructor')).toBeNull();
  });
});

describe('the effect catalogue', () => {
  it('gives every style effect a look to render', () => {
    for (const e of BOOTH_EFFECTS) {
      if (e.kind === 'style') expect(e.style, e.id).toBeTruthy();
    }
  });

  it('pins identity and bans invented names on every built prompt', () => {
    // Both were real failures: restyling drifts faces, and poster
    // styles printed made-up cast names across a wedding photo.
    for (const e of BOOTH_EFFECTS.filter((x) => x.kind === 'style')) {
      const p = buildPrompt(e);
      expect(p, e.id).toMatch(/exact same faces/);
      expect(p, e.id).toMatch(/Do not add any personal names/);
    }
  });

  it('brackets every style with the people-count rule', () => {
    // A solo guest came back standing beside an invented partner. Only
    // stating the rule BEFORE the style as well as after fixed it, so
    // assert the order, not merely the presence.
    for (const e of BOOTH_EFFECTS.filter((x) => x.kind === 'style')) {
      const p = buildPrompt(e);
      const first = p.indexOf('CRITICAL RULE');
      const style = p.indexOf(e.style!.slice(0, 30));
      const last = p.indexOf('Reminder: do not add');
      expect(first, e.id).toBe(0);
      expect(style, e.id).toBeGreaterThan(first);
      expect(last, e.id).toBeGreaterThan(style);
    }
  });

  it('describes wardrobe without counting people', () => {
    // Naming one garment per gender reads as a cast list and is what
    // made the model populate the frame in the first place.
    for (const e of BOOTH_EFFECTS.filter((x) => x.kind === 'style')) {
      expect(e.style, e.id).not.toMatch(/tuxedo and (a )?(taffeta )?(prom )?dress/i);
    }
  });

  it('uses unique ids', () => {
    expect(new Set(BOOTH_EFFECTS.map((e) => e.id)).size).toBe(BOOTH_EFFECTS.length);
  });

  it('never ships prompts to the client', () => {
    // The prompts are the part worth keeping; the picker only needs
    // labels.
    for (const e of publicEffects()) {
      expect(Object.keys(e).sort()).toEqual(['blurb', 'id', 'kind', 'label']);
    }
  });
});

describe('paid-call rate limits', () => {
  it('caps a burst well below the hourly budget', async () => {
    const { GUEST_RATE_LIMITS: L } = await import('../guest-limits.js');
    // client_id is spoofable and a venue is one NAT, so this per-link
    // burst cap is the only thing stopping one caller draining the
    // hour's paid budget in minutes. If it ever stops being much
    // smaller than the hourly cap it has stopped doing its job.
    const burstPerHour = L.faceFilterPerLinkBurst.max * (3_600_000 / L.faceFilterPerLinkBurst.windowMs);
    expect(burstPerHour).toBeGreaterThan(L.faceFilterPerLinkHourly.max);
    expect(L.faceFilterPerLinkBurst.max).toBeLessThan(L.faceFilterPerLinkHourly.max / 4);
  });
});

describe('boothStatus', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.BOOTH_PROVIDER;
    delete process.env.FAL_API_KEY;
    delete process.env.FACE_SWAP_PROVIDER;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is off, and says why, with nothing configured', () => {
    const s = boothStatus();
    expect(s.configured).toBe(false);
    expect(s.styles).toBe(false);
    expect(s.swaps).toBe(false);
    expect(s.reason).toMatch(/BOOTH_PROVIDER/);
  });

  it('stays off when the provider is named but the key is missing', () => {
    process.env.BOOTH_PROVIDER = 'fal';
    expect(boothStatus().reason).toMatch(/FAL_API_KEY/);
    expect(styleConfigured()).toBe(false);
  });

  it('names an unknown provider rather than silently falling back', () => {
    process.env.BOOTH_PROVIDER = 'wat';
    process.env.FAL_API_KEY = 'x';
    expect(boothStatus().reason).toMatch(/unknown provider/);
  });

  it('turns both halves on with fal configured', () => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'x';
    const s = boothStatus();
    expect(s).toMatchObject({ configured: true, styles: true, swaps: true });
  });

  it('treats whitespace as an absent key', () => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = '   ';
    expect(styleConfigured()).toBe(false);
  });

  it('allows swaps on Replicate alone, but not styles', () => {
    // A deployment holding only a Replicate token keeps the swap
    // effects it already had; styles need fal.
    process.env.FACE_SWAP_PROVIDER = 'replicate';
    process.env.REPLICATE_API_TOKEN = 'x';
    process.env.FACE_SWAP_MODEL = 'owner/name';
    expect(swapConfigured()).toBe(true);
    expect(styleConfigured()).toBe(false);
    expect(boothStatus()).toMatchObject({ configured: true, styles: false, swaps: true });
  });
});

describe('hidden photos', () => {
  // The feed filter is a plain predicate; pin its semantics so a photo
  // with no metadata is never mistaken for a hidden one.
  const visible = (metadata: unknown) =>
    ((metadata ?? {}) as Record<string, unknown>)['hidden'] !== true;

  it('keeps photos with no metadata at all', () => {
    expect(visible(null)).toBe(true);
    expect(visible(undefined)).toBe(true);
    expect(visible({})).toBe(true);
  });

  it('keeps photos whose metadata says nothing about hiding', () => {
    expect(visible({ guest_name: 'Dan', source: 'guest' })).toBe(true);
  });

  it('drops only an explicit hidden flag', () => {
    expect(visible({ hidden: true })).toBe(false);
    // Anything short of boolean true stays visible — a stray string
    // must not silently remove a guest's photo.
    expect(visible({ hidden: false })).toBe(true);
    expect(visible({ hidden: 'true' })).toBe(true);
    expect(visible({ hidden: 1 })).toBe(true);
  });
});
