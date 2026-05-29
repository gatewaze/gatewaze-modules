/**
 * Wiki page content hash. spec-ai-memory-wiki.md §4.1 (`content_hash`).
 *
 * sha256 over title + body. Drives: skip-re-embed-when-unchanged, the
 * `git_synced_hash` loop-break, and bidirectional conflict detection (§7).
 * Frontmatter/`metadata` is intentionally NOT hashed here — `content_hash`
 * tracks the prose+title that the embedding and the synced markdown body
 * represent; metadata changes are carried separately on the row.
 */

import { createHash } from 'node:crypto';

export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`, 'utf8').digest('hex');
}
