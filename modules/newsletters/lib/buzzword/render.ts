/**
 * Render the leaderboard to the HTML stored in the resource section's
 * `content`. The resources portal renders a block-less section's `content`
 * verbatim via dangerouslySetInnerHTML (server-side, trusted), so this is
 * plain inline-styled HTML.
 *
 * Deliberately DIV-based, not a <table>: the portal's client sanitiser has
 * been seen to drop <table>/srcset, and flex rows theme and reflow better on
 * mobile. All styles are inline and colour-neutral so the section reads in
 * both light and dark portal themes.
 */

import type { LeaderboardEntry } from './types.js';

/** HTML-escape a string for safe interpolation into text/attribute context. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RenderMeta {
  /** Total human replies counted (extracted). */
  submissions: number;
  /** Distinct phrases on the board. */
  distinct: number;
  /** ISO timestamp of this render, for the "updated" line. */
  updatedAt: string;
}

const RANK_MEDAL = ['🥇', '🥈', '🥉'];

/**
 * Build the leaderboard HTML. Bars are sized relative to the top count so
 * the leader fills the row and the long tail stays readable.
 */
export function renderLeaderboardHtml(
  board: LeaderboardEntry[],
  meta: RenderMeta,
): string {
  if (board.length === 0) {
    return '<p style="opacity:.7;margin:0;">No buzzwords have been submitted yet. Reply to the newsletter with the phrase you hear most in AI.</p>';
  }

  const top = board[0].count || 1;
  const rows = board
    .map((e, i) => {
      const rank = i + 1;
      const badge = RANK_MEDAL[i] ?? `<span style="opacity:.55;font-variant-numeric:tabular-nums;">${rank}</span>`;
      const pct = Math.max(6, Math.round((e.count / top) * 100));
      const plural = e.count === 1 ? 'mention' : 'mentions';
      return [
        '<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid rgba(128,128,128,.18);">',
        `<div style="flex:none;width:28px;text-align:center;font-size:16px;">${badge}</div>`,
        '<div style="flex:1;min-width:0;">',
        `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">`,
        `<span style="font-weight:600;overflow-wrap:anywhere;">${esc(e.display)}</span>`,
        `<span style="flex:none;opacity:.65;font-size:13px;font-variant-numeric:tabular-nums;">${e.count} ${plural}</span>`,
        '</div>',
        `<div style="margin-top:5px;height:7px;border-radius:4px;background:rgba(128,128,128,.16);overflow:hidden;">`,
        `<div style="height:100%;width:${pct}%;border-radius:4px;background:linear-gradient(90deg,#6366f1,#8b5cf6);"></div>`,
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    })
    .join('');

  const updated = formatUpdated(meta.updatedAt);
  const caption = `${meta.submissions} ${meta.submissions === 1 ? 'submission' : 'submissions'} · ${meta.distinct} distinct ${meta.distinct === 1 ? 'phrase' : 'phrases'}${updated ? ` · updated ${updated}` : ''}`;

  return [
    '<div style="max-width:640px;">',
    `<p style="opacity:.7;font-size:13px;margin:0 0 12px;">${esc(caption)}</p>`,
    '<div>',
    rows,
    '</div>',
    '<div style="border-top:1px solid rgba(128,128,128,.18);"></div>',
    '</div>',
  ].join('');
}

/** "14 Jul 2026" — locale-stable, avoids Date parsing surprises downstream. */
function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
