import { describe, it, expect } from 'vitest';

import { hostAllowed } from '../lib/ssrf-guard.js';
import { assertSafeUrl } from '../lib/ssrf-guard.js';
import { pcmToWav } from '../lib/tts.js';
import { wavDurationSeconds } from '../lib/compose.js';
import { mergeOverrides, coerceCharacter, templateSkillId, neutralDefaultProfile } from '../lib/style.js';
import { VehicleVideoError } from '../lib/errors.js';

describe('ssrf host allowlist', () => {
  const allow = ['autotrader.co.uk', 'm.atcdn.co.uk'];
  it('allows the host and its subdomains', () => {
    expect(hostAllowed('autotrader.co.uk', allow)).toBe(true);
    expect(hostAllowed('www.autotrader.co.uk', allow)).toBe(true);
    expect(hostAllowed('m.atcdn.co.uk', allow)).toBe(true);
  });
  it('blocks other hosts (incl. look-alikes)', () => {
    expect(hostAllowed('evil.com', allow)).toBe(false);
    expect(hostAllowed('autotrader.co.uk.evil.com', allow)).toBe(false);
    expect(hostAllowed('notautotrader.co.uk', allow)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('rejects non-https', async () => {
    await expect(assertSafeUrl('http://autotrader.co.uk/x')).rejects.toBeInstanceOf(VehicleVideoError);
  });
  it('rejects hosts outside the allowlist', async () => {
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(VehicleVideoError);
  });
});

describe('pcmToWav / wavDurationSeconds', () => {
  it('produces a 44-byte header and a readable duration', () => {
    // 24000 Hz * 1 ch * 2 bytes = 48000 bytes/sec → 24000 bytes = 0.5s
    const pcm = Buffer.alloc(24000);
    const wav = pcmToWav(pcm, 24000, 1, 16);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wavDurationSeconds(wav)).toBeCloseTo(0.5, 2);
  });
});

describe('style helpers', () => {
  it('maps character → template skill id', () => {
    expect(templateSkillId('heritage')).toBe('vehicle-video-style-heritage');
  });
  it('coerces invalid characters to a safe default', () => {
    expect(coerceCharacter('nonsense')).toBe('executive');
    expect(coerceCharacter('rugged')).toBe('rugged');
  });
  it('merges operator overrides over the inferred profile', () => {
    const base = neutralDefaultProfile();
    const merged = mergeOverrides(base, { vehicle_character: 'performance', style: { pacing: 'edgy_fast' } as any });
    expect(merged.vehicle_character).toBe('performance');
    expect(merged.style.pacing).toBe('edgy_fast');
    // unset knobs keep the base value
    expect(merged.style.camera_energy).toBe(base.style.camera_energy);
  });
});
