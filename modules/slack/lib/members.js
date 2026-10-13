/**
 * Slack members ↔ people: the decisions, with no network or database.
 *
 * A Slack member is linked to a person by email. The link is the person's
 * `attributes.slack_user_id` — Slack's user ID (`U…`/`W…`), which Slack's own
 * UI also calls the "member ID". It is the only Slack identifier Gatewaze
 * matches on; `slack_username` is kept as a display label only.
 */

/** What to do with Slack members (config SLACK_PEOPLE_SYNC). */
export const PEOPLE_SYNC_MODES = ['off', 'link', 'create'];
export const DEFAULT_PEOPLE_SYNC_MODE = 'link';

/**
 * - off    — leave people alone.
 * - link   — write the Slack user ID onto people who already exist (by email).
 * - create — as link, and add a person for a member nobody has yet.
 */
export function peopleSyncMode(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PEOPLE_SYNC_MODES.includes(v) ? v : DEFAULT_PEOPLE_SYNC_MODE;
}

/**
 * Members per call to the link function. Each call runs under PostgREST's
 * statement timeout (8s on Supabase), so keep calls small enough to finish
 * while the database is busy with other work.
 */
export const LINK_BATCH_SIZE = 50;

/** A statement timeout from Postgres, as PostgREST reports it. */
export function isStatementTimeout(err) {
  const m = err && err.message ? err.message : String(err || '');
  return /statement timeout|canceling statement/i.test(m);
}

const NAME_MAX = 200;
const EMAIL_MAX = 254;
const SLACK_ID_RE = /^[UW][A-Z0-9]{2,20}$/;
const EMAIL_RE = /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/;

/** A real person: not a bot, an app, Slackbot, or a deactivated account. */
export function isHumanMember(user) {
  if (!user || typeof user.id !== 'string' || !SLACK_ID_RE.test(user.id)) return false;
  if (user.id === 'USLACKBOT') return false;
  if (user.is_bot || user.is_app_user || user.deleted) return false;
  return true;
}

function clean(value, max = NAME_MAX) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

/**
 * The fields the link function takes, from a Slack user object (users.list,
 * users.info or a team_join event). Names come from the profile's own first
 * and last name, else are split from the real name.
 *
 * @returns {{slack_user_id: string, email: string|null, first_name: string|null,
 *   last_name: string|null, username: string|null} | null} — null when the
 *   object is not a human member.
 */
export function toMemberRecord(user) {
  if (!isHumanMember(user)) return null;
  const p = user.profile || {};
  const rawEmail = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
  const email = rawEmail.length <= EMAIL_MAX && EMAIL_RE.test(rawEmail) ? rawEmail : null;

  let first = clean(p.first_name);
  let last = clean(p.last_name);
  if (!first && !last) {
    const real = clean(p.real_name) || clean(user.real_name);
    if (real) {
      const parts = real.split(' ');
      first = parts[0];
      last = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
  }
  return {
    slack_user_id: user.id,
    email,
    first_name: first,
    last_name: last,
    username: clean(p.display_name) || clean(user.name),
  };
}

/** Count the link function's per-member results: {created: n, updated: n, ...}. */
export function tallyLinkResults(rows, into = {}) {
  for (const r of rows || []) {
    const k = r && typeof r.r_action === 'string' ? r.r_action : 'unknown';
    into[k] = (into[k] || 0) + 1;
  }
  return into;
}
