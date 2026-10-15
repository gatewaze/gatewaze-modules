import { describe, expect, it } from 'vitest';
import { chunk, parseSuppressionCsv, sha256Hex } from '../suppressionCsv';

// Reference values from `printf '%s' <email> | shasum -a 256`.
const JANE = '86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d';
const XY = 'b9984cf42185089cfcf19a4793d9e25ceb7422da9501cfe40add69aa887614cc';

describe('sha256Hex', () => {
  it('matches shasum for the same bytes', async () => {
    expect(await sha256Hex('jane.doe@example.com')).toBe(JANE);
  });
});

describe('parseSuppressionCsv', () => {
  it('hashes addresses after trimming and lowercasing, and accepts existing hashes', async () => {
    const r = await parseSuppressionCsv(['email', '  Jane.Doe@Example.com  ', XY.toUpperCase(), ''].join('\n'));
    expect(r.hashes).toEqual([JANE, XY]);
    expect(r).toMatchObject({ rows: 3, emails: 1, hashesGiven: 1, skipped: 1, duplicates: 0 });
  });

  it('reads the first non-empty cell, with quotes, commas, semicolons or tabs, and CRLF lines', async () => {
    const r = await parseSuppressionCsv('"jane.doe@example.com",Jane\r\n;x@y.io;\r\n\tjane.doe@example.com\r\n');
    expect(r.hashes).toEqual([JANE, XY]);
    expect(r.duplicates).toBe(1);
  });

  it('skips junk rather than hashing it', async () => {
    const r = await parseSuppressionCsv('hash\nnot an email\n1234\nabc@\n');
    expect(r.hashes).toEqual([]);
    expect(r.skipped).toBe(4);
  });
});

describe('chunk', () => {
  it('splits into batches under the RPC limit', () => {
    const parts = chunk(Array.from({ length: 4500 }, (_, i) => i));
    expect(parts.map((p) => p.length)).toEqual([2000, 2000, 500]);
  });
});
