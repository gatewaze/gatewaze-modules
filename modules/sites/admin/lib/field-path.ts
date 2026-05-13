/**
 * JSON pointer ↔ field_path conversion.
 *
 * The schema editor uses RFC-6901 JSON pointers (`/heroTitle`,
 * `/hero/title`, `/contentBlocks/2/title`) because they fall out
 * naturally from JSON Schema walking. The page_variants table — and the
 * walk-page-variants resolver — uses a friendlier dot/bracket form
 * (`heroTitle`, `hero.title`, `contentBlocks[2].title`) because it
 * matches the spec-aaif-theme-deliverable §5.2 vocabulary and the
 * editor surfaces it directly to users.
 *
 * These helpers translate between the two. They reject malformed
 * inputs by throwing — call sites validate upstream so this should
 * only fire on bugs.
 */

export function jsonPointerToFieldPath(pointer: string): string {
  if (pointer === '') return '';
  if (pointer[0] !== '/') {
    throw new Error(`invalid JSON pointer: ${JSON.stringify(pointer)}`);
  }
  const parts = pointer.split('/').slice(1).map(unescapePointer);
  let out = '';
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      out += `[${part}]`;
      continue;
    }
    out += out.length === 0 ? part : `.${part}`;
  }
  return out;
}

export function fieldPathToJsonPointer(fieldPath: string): string {
  if (fieldPath === '') return '';
  let out = '';
  let i = 0;
  while (i < fieldPath.length) {
    if (fieldPath[i] === '.') {
      i += 1;
      continue;
    }
    if (fieldPath[i] === '[') {
      const close = fieldPath.indexOf(']', i + 1);
      if (close === -1) throw new Error(`invalid field_path: ${JSON.stringify(fieldPath)}`);
      const idx = fieldPath.slice(i + 1, close);
      if (!/^\d+$/.test(idx)) throw new Error(`invalid array index in field_path: ${JSON.stringify(fieldPath)}`);
      out += `/${idx}`;
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < fieldPath.length && fieldPath[j] !== '.' && fieldPath[j] !== '[') j += 1;
    out += `/${escapePointer(fieldPath.slice(i, j))}`;
    i = j;
  }
  return out;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}
