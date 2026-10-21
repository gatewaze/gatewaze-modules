import { describe, it, expect } from 'vitest';
import { batchPrefix, titleFromFilename, connectionBundle, looksLikeVideo, logName } from '../lib/batches.js';
import { assertBatchPrefix, batchDays, b2SettingsFromEnv, BATCH_KEY_CAPABILITIES } from '../lib/b2-keys.js';
import { sanitiseBatchInput } from '../api/batches-routes.js';

const ID = '3f9b2c1a-5d6e-4f70-8a91-b2c3d4e5f607';

describe('batch prefix', () => {
  it('is batches/<id>/ and nothing else', () => {
    expect(batchPrefix(ID)).toBe(`batches/${ID}/`);
    expect(() => batchPrefix('../etc')).toThrow();
    expect(assertBatchPrefix(`batches/${ID}/`)).toBe(`batches/${ID}/`);
    expect(() => assertBatchPrefix('batches/')).toThrow();
    expect(() => assertBatchPrefix(`local-import/${ID}/`)).toThrow();
    expect(() => assertBatchPrefix(`batches/${ID}/../`)).toThrow();
  });
});

describe('titleFromFilename', () => {
  it('drops the extension, a leading number and underscores', () => {
    expect(titleFromFilename('03 - Why_Agent_Evals_Miss_What_Production_Catches.mp4')).toBe('Why Agent Evals Miss What Production Catches');
    expect(titleFromFilename('batches/x/Pull Requests Are Dead.MOV')).toBe('Pull Requests Are Dead');
    expect(titleFromFilename('Dexter-State of the Software Factory.mp4')).toBe('Dexter - State of the Software Factory');
  });
});

describe('looksLikeVideo', () => {
  it('wants ftyp at byte 4 for ISO media and the EBML magic for WebM', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
    expect(looksLikeVideo(mp4, 'video/mp4')).toBe(true);
    expect(looksLikeVideo(mp4, 'video/quicktime')).toBe(true);
    expect(looksLikeVideo(webm, 'video/webm')).toBe(true);
    expect(looksLikeVideo(Buffer.from('#EXTM3U\nhttp://x'), 'video/mp4')).toBe(false);
    expect(looksLikeVideo(Buffer.alloc(4), 'video/mp4')).toBe(false);
  });
  it('logName strips control characters', () => {
    expect(logName('talk\n\x1b[31mred.mp4')).toBe('talk??[31mred.mp4');
  });
});

describe('key settings', () => {
  it('clamps days and reads both env values or none', () => {
    expect(batchDays(0)).toBe(1);
    expect(batchDays(90)).toBe(30);
    expect(batchDays('x')).toBe(7);
    expect(b2SettingsFromEnv({ VIDEO_B2_KEY_ID: 'a' })).toBeNull();
    expect(b2SettingsFromEnv({ VIDEO_B2_KEY_ID: 'a', VIDEO_B2_KEY: 'b' })).toEqual({ keyId: 'a', key: 'b' });
  });
  it('a batch key can write and list, nothing else', () => {
    expect([...BATCH_KEY_CAPABILITIES]).toEqual(['writeFiles', 'listFiles']);
  });
});

describe('connectionBundle', () => {
  const b = connectionBundle({ bucket: 'aaif-dev-video-masters', prefix: `batches/${ID}/`, keyId: 'K1', key: 'S/3+x', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', label: 'Day <2>' });
  it('builds the Cyberduck and S3 links with the key encoded, and the rclone pair', () => {
    expect(b.cyberduck_url).toBe(`b2://K1:S%2F3%2Bx@api.backblazeb2.com/aaif-dev-video-masters/batches/${ID}/`);
    expect(b.s3_url).toContain('@s3.us-west-004.backblazeb2.com/aaif-dev-video-masters/batches/');
    expect(b.rclone_conf).toContain('type = b2');
    expect(b.rclone_command).toContain(`gatewaze:aaif-dev-video-masters/batches/${ID}/`);
    expect(b.fields.folder).toBe(`batches/${ID}/`);
  });
  it('escapes the label in the bookmark and leaves the secret out of it', () => {
    expect(b.duck_bookmark).toContain('Day &lt;2&gt;');
    expect(b.duck_bookmark).toContain('<key>Username</key><string>K1</string>');
    expect(b.duck_bookmark).not.toContain('S/3+x');
  });
});

describe('sanitiseBatchInput', () => {
  it('requires a label and cleans the rest', () => {
    expect(sanitiseBatchInput({})).toBeNull();
    expect(sanitiseBatchInput({ label: '  Day  2 ', event_id: ID.toUpperCase(), issued_to_name: ' Dex ', issued_to_email: 'DEX@Example.com', days: 99 }))
      .toEqual({ label: 'Day 2', eventId: ID, name: 'Dex', email: 'dex@example.com', days: 30 });
    expect(sanitiseBatchInput({ label: 'x', event_id: 'nope', issued_to_email: 'not-an-email' })).toMatchObject({ eventId: null, email: null, days: 7 });
  });
});
