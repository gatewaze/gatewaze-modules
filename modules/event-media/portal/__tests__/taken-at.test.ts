// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { exifTakenAt } from '../event-pages/_components/_lib/taken-at';

/** A minimal JPEG carrying one EXIF date, built byte by byte. */
function jpegWith(date: string, { tag = 0x9003, endian = 'II' } = {}): Uint8Array {
  const ascii = `${date}\0`;
  const le = endian === 'II';
  const tiff = new Uint8Array(8 + 2 + 12 * 2 + 4 + ascii.length);
  const dv = new DataView(tiff.buffer);
  tiff[0] = le ? 0x49 : 0x4d; tiff[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);          // IFD0 at 8
  dv.setUint16(8, 1, le);          // one entry
  dv.setUint16(10, 0x8769, le);    // Exif sub-IFD pointer
  dv.setUint16(12, 4, le);
  dv.setUint32(14, 1, le);
  dv.setUint32(18, 22, le);        // sub-IFD at 22
  dv.setUint16(22, 1, le);         // one entry
  dv.setUint16(24, tag, le);
  dv.setUint16(26, 2, le);         // ASCII
  dv.setUint32(28, ascii.length, le);
  dv.setUint32(32, 36, le);        // value at 36
  for (let i = 0; i < ascii.length; i++) tiff[36 + i] = ascii.charCodeAt(i);

  const app1 = new Uint8Array(2 + 2 + 6 + tiff.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  new DataView(app1.buffer).setUint16(2, 2 + 6 + tiff.length, false);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(tiff, 10);

  const out = new Uint8Array(2 + app1.length + 2);
  out[0] = 0xff; out[1] = 0xd8;
  out.set(app1, 2);
  out[out.length - 2] = 0xff; out[out.length - 1] = 0xda; // start of scan
  return out;
}

describe('exifTakenAt', () => {
  it('reads the moment the shutter fired, as local time', () => {
    expect(exifTakenAt(jpegWith('2026:09:25 09:14:07'))).toBe('2026-09-25T09:14:07');
    // Big-endian cameras exist too.
    expect(exifTakenAt(jpegWith('2026:09:25 09:14:07', { endian: 'MM' }))).toBe('2026-09-25T09:14:07');
  });

  it('falls back through the other date tags', () => {
    expect(exifTakenAt(jpegWith('2026:09:24 21:00:00', { tag: 0x9004 }))).toBe('2026-09-24T21:00:00');
  });

  it('says nothing rather than guessing', () => {
    expect(exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull(); // no EXIF
    expect(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // a PNG
    expect(exifTakenAt(new Uint8Array(4))).toBeNull();
    // A camera with a flat battery.
    expect(exifTakenAt(jpegWith('1980:01:01 00:00:00'))).toBeNull();
    expect(exifTakenAt(jpegWith('not a date at all!!'))).toBeNull();
  });

  // Real files, where they are to hand: a phone's own JPEG carries EXIF,
  // and one that has been through a messaging app carries none. Both
  // answers are correct; inventing a date for the second would not be.
  it('reads real photographs, and says nothing about stripped ones', () => {
    const files = ['IMG_0550.jpg', 'IMG_20190731_184255.jpg', 'IMG_3732.jpg']
      .map((f) => `${process.env.HOME}/Downloads/${f}`).filter((p) => existsSync(p));
    if (files.length === 0) return; // not on this machine
    const answers = files.map((p) => exifTakenAt(new Uint8Array(readFileSync(p).subarray(0, 128 * 1024))));
    for (const at of answers) {
      if (at !== null) expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
    expect(answers.some((at) => at !== null)).toBe(true);
  });
});

import { takenAtOf } from '../event-pages/_components/_lib/taken-at';

describe('takenAtOf, as the phone calls it', () => {
  const asFile = (path: string, type = 'image/jpeg') =>
    new File([readFileSync(path)], path.split('/').pop()!, { type });

  it('reads the date from a real photograph, without reading the whole file', async () => {
    const path = `${process.env.HOME}/Downloads/IMG_0550.jpg`;
    if (!existsSync(path)) return;
    const file = asFile(path);
    expect(await takenAtOf(file)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // Only the head is needed: a 128KB slice answers for a multi-MB file.
    expect(file.size).toBeGreaterThan(128 * 1024);
  });

  it('says nothing for a video, a PNG or a photograph with no EXIF', async () => {
    const stripped = `${process.env.HOME}/Downloads/IMG_3732.jpg`;
    if (existsSync(stripped)) expect(await takenAtOf(asFile(stripped))).toBeNull();
    expect(await takenAtOf(new File([new Uint8Array([1, 2, 3])], 'clip.mov', { type: 'video/quicktime' }))).toBeNull();
    expect(await takenAtOf(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' }))).toBeNull();
  });
});
