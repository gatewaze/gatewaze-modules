/**
 * One-click unsubscribes for broadcasts: saving the suppression, and which
 * response to give.
 *
 * broadcast_suppressions is unique on (lower(email), topic), an expression
 * index, so PostgREST's upsert with onConflict 'email,topic' cannot target it
 * and Postgres rejects every such insert (42P10). A plain insert is used
 * instead, and a duplicate (23505) means the address is already suppressed.
 *
 * A row the email-verification module added for an invalid address can be
 * lifted later by an admin. When the person unsubscribes from the same topic,
 * that row becomes their unsubscribe, so lifting it cannot undo an opt-out.
 * Both modules store the address lower-cased, so an exact match finds it.
 *
 * No imports, so the edge function and the node tests both load it.
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from(table: string): any };

export type SuppressResult = { ok: true; alreadySuppressed: boolean } | { ok: false; error: string };

const ROW = { source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' };

async function insert(supabase: SupabaseLike, email: string, topic: string) {
  const { error } = await supabase.from('broadcast_suppressions').insert({ email, topic, ...ROW });
  return error as { code?: string; message?: string } | null;
}

export async function recordUnsubscribe(supabase: SupabaseLike, rawEmail: string, topic: string): Promise<SuppressResult> {
  const email = rawEmail.trim().toLowerCase();
  const first = await insert(supabase, email, topic);
  if (!first) return { ok: true, alreadySuppressed: false };
  if (first.code !== '23505') return { ok: false, error: first.message ?? String(first) };

  const { data: claimed, error: claimErr } = await supabase
    .from('broadcast_suppressions')
    .update(ROW)
    .eq('email', email)
    .eq('topic', topic)
    .eq('source', 'email-verification')
    .select('id');
  if (claimErr) return { ok: false, error: claimErr.message ?? String(claimErr) };
  if (Array.isArray(claimed) && claimed.length > 0) return { ok: true, alreadySuppressed: true };

  // Nothing taken over: the existing row is an unsubscribe, a manual or bounce
  // suppression (all fine), or it was lifted between the insert and now. Try
  // once more so a lifted row cannot leave the person unsuppressed.
  const again = await insert(supabase, email, topic);
  if (!again || again.code === '23505') return { ok: true, alreadySuppressed: !!again };
  return { ok: false, error: again.message ?? String(again) };
}

/**
 * What to do with a request. A plain GET only shows a confirm button, because
 * mail security scanners open links and must not unsubscribe anyone (the same
 * rule as newsletter-unsubscribe). The confirm form posts `confirm=1`; mail
 * clients' RFC 8058 one-click POST sends `List-Unsubscribe=One-Click`.
 */
export type UnsubscribeStep =
  | { action: 'confirm-page' }
  | { action: 'suppress'; reply: 'json' | 'html' }
  | { action: 'reject' };

export function unsubscribeStep(method: string, formBody: string): UnsubscribeStep {
  if (method === 'GET') return { action: 'confirm-page' };
  if (method !== 'POST') return { action: 'reject' };
  const form = new URLSearchParams(formBody);
  return { action: 'suppress', reply: form.get('confirm') === '1' ? 'html' : 'json' };
}

/** Status for the outcome of a save: never claim success when nothing was saved. */
export function unsubscribeStatus(saved: SuppressResult): number {
  return saved.ok ? 200 : 500;
}
