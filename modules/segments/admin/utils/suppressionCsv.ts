/**
 * Read a suppression list CSV in the browser and turn it into SHA-256 hashes.
 *
 * Each row's first non-empty cell is either an email address or an existing
 * hex SHA-256 hash. Addresses are hashed here, before anything is uploaded, so
 * the server only ever receives hashes. The hash is the hex SHA-256 of the
 * UTF-8 bytes of the address trimmed and lowercased, the same expression the
 * database uses to match people (migration 020).
 */

const HASH_RX = /^[0-9a-f]{64}$/i;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SuppressionCsvResult {
  /** Unique lowercase hex hashes, ready to upload. */
  hashes: string[];
  rows: number;
  emails: number;
  hashesGiven: number;
  duplicates: number;
  /** Rows that were neither an address nor a hash (headers, blanks, junk). */
  skipped: number;
}

function firstCell(line: string): string {
  for (const raw of line.split(/[,;\t]/)) {
    const cell = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (cell) return cell;
  }
  return '';
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function parseSuppressionCsv(text: string): Promise<SuppressionCsvResult> {
  const seen = new Set<string>();
  const result: SuppressionCsvResult = { hashes: [], rows: 0, emails: 0, hashesGiven: 0, duplicates: 0, skipped: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    result.rows++;
    const cell = firstCell(line);
    let hash: string | null = null;
    if (HASH_RX.test(cell)) {
      hash = cell.toLowerCase();
      result.hashesGiven++;
    } else if (EMAIL_RX.test(cell)) {
      hash = await sha256Hex(normaliseEmail(cell));
      result.emails++;
    } else {
      result.skipped++;
      continue;
    }
    if (seen.has(hash)) { result.duplicates++; continue; }
    seen.add(hash);
    result.hashes.push(hash);
  }
  return result;
}

/** Split into upload batches (the RPC accepts at most 5,000 per call). */
export function chunk<T>(items: ReadonlyArray<T>, size = 2000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
