/**
 * When a photograph was taken, from the photograph itself.
 *
 * The album a guest's upload lands in used to be decided by the clock at
 * the moment it arrived: before the event started it was Getting ready,
 * after it The day. That is right while the party is on and wrong
 * afterwards -- somebody emptying their camera roll on the Sunday put
 * their getting-ready photographs into The day (asked 2026-09-27).
 *
 * A JPEG carries the answer in its EXIF: DateTimeOriginal, written by
 * the camera when the shutter fired. This reads it out of the first few
 * kilobytes of the file, which is all the header takes, and says nothing
 * when the file has no EXIF (a screenshot, a download, a picture that
 * has been through a tool that stripped it).
 *
 * The time has no timezone in it. It is the local time on the camera,
 * which for a wedding is the local time of the wedding, so it is
 * returned as a local timestamp rather than UTC.
 */

/** EXIF tags that carry a date, in the order we prefer them. */
const DATE_TAGS = [0x9003, 0x9004, 0x0132] as const; // Original, Digitized, ModifyDate

/** `YYYY:MM:DD HH:MM:SS` as EXIF writes it. */
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function readDate(text: string): string | null {
  const m = EXIF_DATE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  // A camera with a flat battery writes 1980; a file with a garbled
  // header can produce anything. Neither is a date worth believing.
  if (year < 2000 || year > 2100) return null;
  const mon = Number(mo);
  const day = Number(d);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  // No zone: local time, as the camera recorded it.
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * The capture time from a JPEG's EXIF, as `YYYY-MM-DDTHH:MM:SS` in the
 * camera's own local time, or null if there is not one to be had.
 *
 * Give it the start of the file; 128KB is more than enough.
 */
export function exifTakenAt(bytes: Uint8Array): string | null {
  // JPEG, and long enough to hold a header.
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walk the markers to APP1.
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1]!;
    const size = view.getUint16(p + 2, false);
    if (size < 2) return null;
    // APP1 holds EXIF; SOS means the picture has started and there is
    // no EXIF to find.
    if (marker === 0xda) return null;
    if (marker === 0xe1 && p + 10 <= bytes.length) {
      const tag = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (tag === 'Exif') return readTiff(view, bytes, p + 10, Math.min(bytes.length, p + 2 + size));
    }
    p += 2 + size;
  }
  return null;
}

/** The TIFF block inside APP1: a header, then IFDs of tagged fields. */
function readTiff(view: DataView, bytes: Uint8Array, start: number, end: number): string | null {
  if (start + 8 > end) return null;
  const le = bytes[start] === 0x49 && bytes[start + 1] === 0x49; // 'II' or 'MM'
  if (!le && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d)) return null;
  if (view.getUint16(start + 2, le) !== 42) return null;

  const found = new Map<number, string>();
  const seen = new Set<number>();

  const readIfd = (offset: number, depth: number): void => {
    // Offsets come from the file, so a malformed one must not send this
    // round in circles or off the end.
    if (depth > 2 || seen.has(offset)) return;
    seen.add(offset);
    const at = start + offset;
    if (at + 2 > end) return;
    const count = view.getUint16(at, le);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > end) return;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const length = view.getUint32(entry + 4, le);
      // The Exif sub-IFD, where DateTimeOriginal lives.
      if (tag === 0x8769 && type === 4) {
        readIfd(view.getUint32(entry + 8, le), depth + 1);
        continue;
      }
      if (!(DATE_TAGS as readonly number[]).includes(tag)) continue;
      if (type !== 2 || length < 19 || length > 64) continue;
      // An ASCII field this long is always stored out of line.
      const valueAt = start + view.getUint32(entry + 8, le);
      if (valueAt + length > end) continue;
      const text = String.fromCharCode(...bytes.subarray(valueAt, valueAt + length - 1));
      const date = readDate(text);
      if (date && !found.has(tag)) found.set(tag, date);
    }
  };

  readIfd(view.getUint32(start + 4, le), 0);
  for (const tag of DATE_TAGS) {
    const date = found.get(tag);
    if (date) return date;
  }
  return null;
}

const HEAD_BYTES = 128 * 1024

export async function takenAtOf(file: File): Promise<string | null> {
  try {
    if (!/^image\/jpe?g$/i.test(file.type)) return null
    const head = await file.slice(0, HEAD_BYTES).arrayBuffer()
    return exifTakenAt(new Uint8Array(head))
  } catch {
    // An unreadable file is the upload's problem, not this one's.
    return null
  }
}
