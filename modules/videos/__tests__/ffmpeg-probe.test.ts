import { describe, it, expect } from 'vitest';
import { parseProbe, tsArg } from '../lib/ffmpeg.js';
import { matchArgs, cardLayout, whoLine } from '../lib/preroll.js';

const REPORT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'master.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:17:08.12, start: 0.000000, bitrate: 4620 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4500 kb/s, 25 fps, 25 tbr, 90k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
`;

describe('parseProbe', () => {
  it('reads duration, size, frame rate, codecs and audio layout from the -i report', () => {
    const p = parseProbe(REPORT);
    expect(p.durationSeconds).toBeCloseTo(1028.12, 2);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
    expect(p.fps).toBe(25);
    expect(p.videoCodec).toBe('h264');
    expect(p.videoProfile).toBe('High');
    expect(p.pixFmt).toBe('yuv420p');
    expect(p.audioCodec).toBe('aac');
    expect(p.audioRate).toBe(44100);
    expect(p.audioChannels).toBe(2);
  });
  it('tolerates a mono 48k track at 29.97 fps', () => {
    const p = parseProbe(REPORT.replace('25 fps', '29.97 fps').replace('44100 Hz, stereo', '48000 Hz, mono'));
    expect(p.fps).toBe(29.97);
    expect(p.audioRate).toBe(48000);
    expect(p.audioChannels).toBe(1);
  });
  it('returns zeros for an empty report', () => {
    expect(parseProbe('').durationSeconds).toBe(0);
  });
  it('ignores a stream line spelled out in the file\'s own metadata, and caps the size', () => {
    const spoofed = REPORT.replace('    major_brand     : isom', '    title           : Stream #0:0: Video: h264, yuv420p(, 99999x99999, 999 fps');
    const p = parseProbe(spoofed);
    expect(p.width).toBe(1920);
    expect(p.fps).toBe(25);
    const huge = parseProbe(REPORT.replace('1920x1080', '99999x99999').replace('25 fps', '999 fps'));
    expect(huge.width).toBe(8192);
    expect(huge.fps).toBe(240);
  });
});

describe('tsArg', () => {
  it('formats numbers and refuses anything else', () => {
    expect(tsArg(12.3456)).toBe('12.346');
    expect(() => tsArg(-1)).toThrow();
    expect(() => tsArg(Number('abc'))).toThrow();
  });
});

describe('matchArgs', () => {
  it('encodes the card to the master\'s own parameters', () => {
    const args = matchArgs(parseProbe(REPORT));
    expect(args).toContain('scale=1920:1080,format=yuv420p');
    expect(args).toContain('high');
    expect(args).toContain('keyint=50:min-keyint=25');
    expect(args).toContain('44100');
    expect(args[args.indexOf('-r') + 1]).toBe('25');
  });
  it('falls back to sane defaults when the probe is silent', () => {
    const args = matchArgs({ durationSeconds: 1, width: 1280, height: 720, fps: 0, videoCodec: '', videoProfile: '', pixFmt: '', audioCodec: '', audioRate: 0, audioChannels: 0 });
    expect(args[args.indexOf('-r') + 1]).toBe('25');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args).toContain('scale=1280:720,format=yuv420p');
  });
});

describe('card', () => {
  it('lays out one, two or three lines of title', () => {
    expect(cardLayout('Short title')).toEqual({ lines: 1, titleTop: 420, whoTop: 554 });
    expect(cardLayout('How we Reclaimed Significant Engineering Capacity at Salesforce').lines).toBe(2);
    expect(cardLayout('A'.repeat(80)).lines).toBe(3);
  });
  it('escapes the speaker line', () => {
    expect(whoLine([{ name: 'Dex <b>', role: 'CEO', company: 'HumanLayer & Co' }])).toBe('<b>Dex &lt;b&gt;</b>, CEO, HumanLayer &amp; Co');
    expect(whoLine([{ name: '' }])).toBe('');
  });
});
