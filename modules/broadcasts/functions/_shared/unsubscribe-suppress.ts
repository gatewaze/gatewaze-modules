/**
 * Record a one-click unsubscribe as a broadcast suppression.
 *
 * broadcast_suppressions is unique on (lower(email), topic), an expression
 * index, so PostgREST's upsert with onConflict 'email,topic' cannot target it
 * and Postgres rejects every such insert (42P10). A plain insert is used
 * instead, and a duplicate (23505) means the address is already suppressed.
 *
 * A row the email-verification module added for an invalid address can be
 * lifted later by an admin. When the person unsubscribes from the same topic,
 * that row becomes their unsubscribe, so lifting it can never undo an opt-out.
 *
 * No imports, so the edge function and the node tests both load it.
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from(table: string): any };

export type SuppressResult = { ok: true; alreadySuppressed: boolean } | { ok: false; error: string };

/** Escape LIKE wildcards so the address matches only itself. */
function likeExact(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function recordUnsubscribe(supabase: SupabaseLike, rawEmail: string, topic: string): Promise<SuppressResult> {
  const email = rawEmail.trim().toLowerCase();
  const { error } = await supabase
    .from('broadcast_suppressions')
    .insert({ email, topic, source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' });
  if (!error) return { ok: true, alreadySuppressed: false };
  if (error.code !== '23505') return { ok: false, error: error.message ?? String(error) };
  // PostgREST also reads * as a wildcard, so such an address could match
  // others. It is suppressed either way; just leave the existing row alone.
  if (email.includes('*')) return { ok: true, alreadySuppressed: true };

  const { error: claimErr } = await supabase
    .from('broadcast_suppressions')
    .update({ source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' })
    .ilike('email', likeExact(email))
    .eq('topic', topic)
    .eq('source', 'email-verification');
  if (claimErr) return { ok: false, error: claimErr.message ?? String(claimErr) };
  return { ok: true, alreadySuppressed: true };
}
