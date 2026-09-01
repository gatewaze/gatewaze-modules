/**
 * Send-time member gating for newsletter blocks.
 *
 * A members-only block is rendered normally into `rendered_html` at export, but
 * wrapped between two empty sentinel spans that carry the block's tier + custom
 * placeholder (EditionEmail, forSend only):
 *
 *   <span data-gwgate="<id>" data-gwph="<b64>"></span>REAL_BLOCK_HTML<span data-gwgate-end="<id>"></span>
 *
 * At send time `parseGatedBlocks` lifts each region out of the HTML, replacing
 * the whole region (both sentinels + the real HTML) with a per-recipient token
 * `{{gate_<id>}}`. The binding then substitutes that token with the REAL block
 * HTML for a qualifying member, or a members-only PLACEHOLDER for everyone else
 * — so the real content is only ever delivered to a member. On any uncertainty
 * (membership lookup fails, marker malformed) the caller substitutes the
 * placeholder: fail-closed, a gated block never leaks.
 */

export interface GatePlaceholder {
  title?: string;
  body?: string;
  cta_label?: string;
  cta_url?: string;
}

export interface GatedBlock {
  id: string;
  token: string;          // {{gate_<id>}}
  tier: number;           // min member tier_rank (0 = any member)
  placeholder: GatePlaceholder | null; // block's custom override, else null -> caller default
  realHtml: string;       // the block's true rendered HTML
}

// Matches a start sentinel, captures the base64 config + the real HTML up to the
// matching end sentinel (keyed by the same id via the \1 backreference). Matches
// the EXACT shape EditionEmail emits: `<span data-gwgate="<id>" data-gwph="<b64>">
// </span>` — a bare span, attributes in that fixed order (react-email preserves
// JSX prop order), no other attributes. Deliberately LINEAR: no `[^>]*` segments
// (those made it a polynomial-backtracking / ReDoS regex over attacker-influenceable
// html). Only the id/base64 char classes, single bounded `\s*` between fixed
// literals, and one lazy `[\s\S]*?` terminated by a specific end sentinel.
const GATE_RE =
  /<span data-gwgate="([0-9a-fA-F-]+)" data-gwph="([A-Za-z0-9+/=]*)"\s*>\s*<\/span>([\s\S]*?)<span data-gwgate-end="\1"\s*>\s*<\/span>/g;

/** UTF-8-safe base64 decode (Node worker). */
function b64decode(b64: string): string {
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Lift every gated block out of `html`, replacing each region with its
 * `{{gate_<id>}}` token. Returns the rewritten html + the extracted blocks.
 * Blocks with no membership system installed still parse fine — the binding
 * simply resolves everyone to non-member and shows the placeholder.
 */
export function parseGatedBlocks(html: string): { html: string; gates: GatedBlock[] } {
  const gates: GatedBlock[] = [];
  const seen = new Set<string>();
  const out = html.replace(GATE_RE, (_full, id: string, b64: string, realHtml: string) => {
    let tier = 0;
    let placeholder: GatePlaceholder | null = null;
    try {
      const cfg = JSON.parse(b64decode(b64)) as { t?: unknown; p?: unknown };
      tier = Number(cfg.t) || 0;
      placeholder = cfg.p && typeof cfg.p === 'object' ? (cfg.p as GatePlaceholder) : null;
    } catch {
      /* malformed config -> tier 0 + default placeholder. A non-member still
         never sees the block (fail-closed across the public/member boundary);
         tier 0 is only the least-restrictive *member* tier if the config was
         corrupted, which trusted server/client emission does not produce. */
    }
    const token = `{{gate_${id}}}`;
    // Guard against a duplicate id somehow appearing twice: keep the first.
    if (!seen.has(id)) {
      seen.add(id);
      gates.push({ id, token, tier, placeholder, realHtml });
    }
    return token;
  });
  return { html: out, gates };
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Email-safe HTML for the members-only placeholder. `def` is the platform
 * default (fetched once per send); a block's custom placeholder overrides field
 * by field. A relative cta_url (e.g. /sign-in) is resolved against portalBaseUrl.
 */
export function renderGatePlaceholderHtml(
  ph: GatePlaceholder | null,
  def: GatePlaceholder,
  portalBaseUrl: string | null,
): string {
  const p: GatePlaceholder = { ...def, ...(ph || {}) };
  const title = esc(p.title || 'Members only');
  const body = esc(p.body || 'This section is for members. Sign in with your member email to read it.');
  const label = esc(p.cta_label || 'Sign in to read');
  let url = p.cta_url || '/sign-in';
  // Scheme allowlist (matches the Button.tsx SAFE_HREF convention) — never let a
  // javascript:/data: URL through even though the placeholder is admin-authored.
  const SAFE_HREF = /^(https?:|mailto:|tel:|\/)/i;
  if (!SAFE_HREF.test(url)) url = '/sign-in';
  if (/^\//.test(url) && portalBaseUrl) url = `${portalBaseUrl.replace(/\/$/, '')}${url}`;
  const cta = url
    ? `<div style="margin-top:14px;"><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#ffffff;` +
      `text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">${label}</a></div>`
    : '';
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;">` +
    `<tr><td style="border:1px dashed #d1d5db;background:#f9fafb;border-radius:12px;padding:22px;text-align:center;` +
    `font-family:Helvetica,Arial,sans-serif;">` +
    `<div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#6b7280;">&#128274; ${title}</div>` +
    `<div style="font-size:15px;color:#374151;margin-top:8px;max-width:420px;margin-left:auto;margin-right:auto;">${body}</div>` +
    cta +
    `</td></tr></table>`
  );
}
