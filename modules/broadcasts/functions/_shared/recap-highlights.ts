/**
 * Recap-highlights rendering + ranking, shared between:
 *   - the draft-from-recap worker (aggregate ranking at DRAFT time), and
 *   - the send-engine binding (per-recipient ranking at SEND time).
 *
 * Personalization model (mirrors the Local/Virtual Events blocks): when a play
 * is set to personalise, the draft emits the token `{{recap_highlights_block}}`
 * plus a marker comment carrying the source recap item + highlight count. At
 * send time the binding parses the marker, loads the candidate talks once, and
 * for each recipient ranks them by THAT person's topic affinity, substituting
 * the token with their own top-N HTML (or '' to omit). SendGrid does the raw
 * per-recipient substitution — one batch call, personalised bodies.
 */

export const RECAP_TOKEN = '{{recap_highlights_block}}';
export const RECAP_INNER = 'recap_highlights_block';
const RECAP_MARKER_RE = /<!--gw-recap-highlights:(\{.*?\})-->/;

export const AUTO_TOPIC_WEIGHT = 0.5;

export interface RecapMarker { item_id: string; count: number; event_name: string }
export interface TalkBlock { kind?: string; data?: Record<string, any>; sort_order?: number }

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
}

export function talkLink(data: Record<string, any> | undefined): string | null {
  if (data && data.url) return String(data.url);
  if (data && data.youtube_id) return `https://www.youtube.com/watch?v=${encodeURIComponent(data.youtube_id)}`;
  return null;
}

/** Score one talk block against an affinity Map<topic, weight>. */
export function scoreTalk(block: TalkBlock, affinity: Map<string, number>): number {
  const d = (block && block.data) || {};
  const curated: string[] = Array.isArray(d.topics) ? d.topics.map(String) : [];
  const auto: string[] = Array.isArray(d.topics_auto) ? d.topics_auto.map(String) : [];
  let score = 0;
  const counted = new Set<string>();
  for (const t of curated) { const w = affinity.get(t); if (w) { score += w; counted.add(t); } }
  for (const t of auto) { if (counted.has(t)) continue; const w = affinity.get(t); if (w) score += w * AUTO_TOPIC_WEIGHT; }
  return score;
}

/**
 * Rank candidate talks by an affinity map and return the top `count`. Stable:
 * ties (and the no-affinity case) keep the original curated order, so an empty
 * affinity map yields the first `count` talks verbatim.
 */
export function rankTalks(talks: TalkBlock[], affinity: Map<string, number>, count: number): TalkBlock[] {
  const all = talks || [];
  if (all.length <= count) return all.slice(0, count);
  const scored = all.map((item, index) => ({ item, index, score: scoreTalk(item, affinity) }));
  if (!scored.some((s) => s.score > 0)) return all.slice(0, count);
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, count).map((s) => s.item);
}

export function buildHighlightsHtml(eventName: string, talks: TalkBlock[]): string {
  const cards = (talks || []).map((t) => {
    const d = t.data || {};
    const speaker = d.speaker && d.speaker.name ? d.speaker.name : (Array.isArray(d.speakers) && d.speakers[0] ? d.speakers[0].name : '');
    const company = d.speaker && d.speaker.company ? d.speaker.company : '';
    const by = speaker ? `${esc(speaker)}${company ? ' · ' + esc(company) : ''}` : '';
    const takeaway = d.worth_noting || d.quote || '';
    const link = talkLink(d);
    return `
      <tr><td style="padding:16px 0;border-bottom:1px solid #eee;">
        <div style="font-size:16px;font-weight:600;color:#111;line-height:1.3;">${esc(d.title || 'Untitled talk')}</div>
        ${by ? `<div style="font-size:13px;color:#666;margin-top:2px;">${by}</div>` : ''}
        ${takeaway ? `<div style="font-size:14px;color:#333;margin-top:8px;line-height:1.5;">${esc(takeaway)}</div>` : ''}
        ${link ? `<div style="margin-top:8px;"><a href="${esc(link)}" style="font-size:13px;color:#2563eb;text-decoration:none;">Watch the talk →</a></div>` : ''}
      </td></tr>`;
  }).join('');
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h1 style="font-size:22px;color:#111;margin:0 0 4px;">Highlights from ${esc(eventName)}</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;margin:0 0 16px;">
        Thanks for being part of ${esc(eventName)}. Here are a few highlights from the sessions — catch up on what you missed and revisit your favourites.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${cards}</table>
      <p style="font-size:13px;color:#888;margin:20px 0 0;">Watch every session in the full recap.</p>
    </div>`;
}

/** Emit the marker comment carrying the personalized-block config. */
export function recapMarker(m: RecapMarker): string {
  return `<!--gw-recap-highlights:${JSON.stringify({ item_id: m.item_id, count: m.count, event_name: m.event_name })}-->`;
}

/** Parse the marker back out of body HTML (null when absent/invalid). */
export function parseRecapMarker(html: string): RecapMarker | null {
  const m = html.match(RECAP_MARKER_RE);
  if (!m) return null;
  try {
    const cfg = JSON.parse(m[1]);
    if (!cfg || typeof cfg.item_id !== 'string') return null;
    return { item_id: cfg.item_id, count: Math.max(1, Math.min(12, Number(cfg.count) || 4)), event_name: String(cfg.event_name || 'the event') };
  } catch { return null; }
}

export function stripRecapMarker(html: string): string {
  return html.replace(new RegExp(RECAP_MARKER_RE.source, 'g'), '');
}
