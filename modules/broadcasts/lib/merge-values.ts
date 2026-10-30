/**
 * Merge-field helpers shared by the email and Slack broadcast bindings. No
 * imports, so the API routes can use them without loading either binding.
 */
export function unquote(fb: string): string {
  const t = fb.trim();
  return (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) ? t.slice(1, -1) : t;
}
// {{email_encoded}}: the recipient's address in the legacy tech.tickets
// encoding (XOR with "HideMe", then URL-safe base64). The portal decodes it
// from ?utm_medium= / ?e= (packages/portal/lib/emailEncoding.ts) to know who
// clicked, e.g. /offers/<slug>?utm_medium={{email_encoded}}. It identifies,
// it does not authenticate: anyone can encode any address. Keep in step with
// the portal's decodeEmail.
export function encodeEmail(email: string): string {
  // The legacy encoding is byte-wise; a non-ASCII address has no stable
  // form in it. Leave the link without an address and the offer page asks.
  if (/[^\x20-\x7e]/.test(email)) return '';
  const lower = email.toLowerCase();
  const pass = 'HideMe';
  let bin = '';
  for (let i = 0; i < lower.length; i++) bin += String.fromCharCode(lower.charCodeAt(i) ^ pass.charCodeAt(i % pass.length));
  return Buffer.from(bin, 'latin1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
