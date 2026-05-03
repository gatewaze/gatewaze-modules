/**
 * Newsletter editions — publish-branch writer + snapshot job + PII filter.
 *
 * Per spec-content-modules-git-architecture §15:
 *
 *   1. On send: write `editions/<YYYY-MM-DD-HHMM-slug>/` to publish branch.
 *      Files: rendered.html (template-level, merge-tag placeholders intact),
 *             rendered.txt, content.json, metadata.json (status='sent').
 *      Tag: edition/<YYYY-MM-DD-HHMM-slug>
 *
 *   2. PII filter: never write recipient emails, per-recipient personalized HTML,
 *      per-recipient engagement, bounce/complaint detail.
 *
 *   3. Snapshot job: <snapshot_delay_days> after sent_at, update metadata.json
 *      to status='closed' with final aggregate stats; purge per-recipient HTML
 *      from DB.
 */

export interface EditionPayload {
  editionId: string;
  listId: string;
  listSlug: string;
  subject: string;
  /** Template-rendered HTML with merge-tag placeholders intact. */
  renderedHtml: string;
  /** Plaintext alternate. */
  renderedText: string;
  /** The editorial content/variables that fed the template. */
  content: Record<string, unknown>;
  /** Sent timestamp (ISO 8601). */
  sentAt: string;
  /** Sender display name + address (e.g., "AAIF News <news@aaif.org>"). */
  sender: string;
  /** SHA of the template state at send time. */
  templateSha: string;
  /** Aggregate count: never per-recipient. */
  sendCount: number;
}

export interface SnapshotPayload {
  editionId: string;
  /** Final aggregate stats taken at snapshot_at. */
  finalStats: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
  };
  snapshotAt: string;
}

// ============================================================================
// PII boundary — assertions used by tests
// ============================================================================

const PII_PATTERNS = [
  // Email regex (simple but catches obvious leaks)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // ESP-specific recipient identifiers
  /\bx-mailgun-recipient\b/i,
  /\bsendgrid_recipient_id\b/i,
];

const ALLOWED_MERGE_TAGS = /\{\{[^}]+\}\}/g;

/**
 * Throws if rendered HTML contains real PII.
 * Allows merge-tag placeholders (`{{first_name}}`).
 */
export function assertNoPiiInRendered(html: string): void {
  // Strip merge-tag placeholders before scanning
  const stripped = html.replace(ALLOWED_MERGE_TAGS, '__MERGETAG__');
  for (const pattern of PII_PATTERNS) {
    const match = stripped.match(pattern);
    if (match) {
      throw new Error(
        `PII boundary violation: rendered HTML contains real PII matching ${pattern.source}. ` +
        `Found: "${match[0]}". Per spec §15.3, only template-level rendered HTML with merge-tag placeholders ` +
        `intact (e.g. {{first_name}}) may be written to git.`,
      );
    }
  }
}

// ============================================================================
// Edition payload → publish-branch files
// ============================================================================

export interface PublishFiles {
  /** Map of relative-path → contents. Keys are like 'editions/<slug>/rendered.html'. */
  files: Map<string, Buffer | string>;
  /** Tag to apply to the resulting commit. */
  tag: string;
  /** Commit message. */
  message: string;
}

export function buildEditionPublishFiles(payload: EditionPayload): PublishFiles {
  // Validate PII boundary BEFORE constructing the files
  assertNoPiiInRendered(payload.renderedHtml);
  assertNoPiiInRendered(payload.renderedText);

  const dirName = buildEditionDirName(payload);
  const files = new Map<string, Buffer | string>();
  files.set(`editions/${dirName}/rendered.html`, payload.renderedHtml);
  files.set(`editions/${dirName}/rendered.txt`, payload.renderedText);
  files.set(
    `editions/${dirName}/content.json`,
    JSON.stringify(payload.content, null, 2),
  );
  files.set(
    `editions/${dirName}/metadata.json`,
    JSON.stringify(
      {
        status: 'sent',
        subject: payload.subject,
        sender: payload.sender,
        sent_at: payload.sentAt,
        template_sha: payload.templateSha,
        send_count: payload.sendCount,
      },
      null,
      2,
    ),
  );
  return {
    files,
    tag: `edition/${dirName}`,
    message: `Send: ${payload.subject}`,
  };
}

/**
 * Snapshot update: rewrites metadata.json with final stats. Returns the
 * file map suitable for a publish commit (the working tree is otherwise
 * unchanged).
 */
export function buildSnapshotPublishFiles(
  payload: SnapshotPayload,
  /** The original edition payload (we need slug + sent_at to find the dir). */
  origin: { sentAt: string; listSlug: string; subject: string; sender: string; templateSha: string; sendCount: number },
): PublishFiles {
  const dirName = buildEditionDirName({
    sentAt: origin.sentAt,
    listSlug: origin.listSlug,
    subject: origin.subject,
  } as EditionPayload);
  const files = new Map<string, Buffer | string>();
  files.set(
    `editions/${dirName}/metadata.json`,
    JSON.stringify(
      {
        status: 'closed',
        subject: origin.subject,
        sender: origin.sender,
        sent_at: origin.sentAt,
        template_sha: origin.templateSha,
        send_count: origin.sendCount,
        final_stats: payload.finalStats,
        snapshot_at: payload.snapshotAt,
      },
      null,
      2,
    ),
  );
  return {
    files,
    tag: '',
    message: `Snapshot: ${origin.subject}`,
  };
}

/**
 * Build the time-qualified directory name `YYYY-MM-DD-HHMM-<slug>`.
 * Per spec §15.2: time-qualified for uniqueness even when same name on same day.
 */
export function buildEditionDirName(payload: Pick<EditionPayload, 'sentAt' | 'subject'>): string {
  const d = new Date(payload.sentAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const slug = slugify(payload.subject);
  return `${yyyy}-${mm}-${dd}-${hh}${mi}-${slug}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
