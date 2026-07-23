import type { Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface PruneJobData { kind: string }

/**
 * Retention sweep for email_send_log.content_html.
 *
 * The send engine stores the exact rendered HTML for newsletter/broadcast sends
 * so the People > Emails tab can show what was sent. That body is large, so we
 * only keep it for a window, then null it out (the row and its open/click
 * tracking remain). Window: EMAIL_CONTENT_HTML_RETENTION_DAYS (default 180).
 *
 * Runs hourly. Works the backlog down a bounded slice at a time so a large
 * first sweep doesn't run long; steady state finds nothing and returns fast.
 */
export default async function handlePruneContentHtml(_job: Job<PruneJobData>) {
  const days = Number(process.env.EMAIL_CONTENT_HTML_RETENTION_DAYS ?? 180);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let total = 0;
  try {
    for (let i = 0; i < 20; i++) {
      const { data, error } = await supabase
        .from('email_send_log')
        .select('id')
        .not('content_html', 'is', null)
        .lt('sent_at', cutoff)
        .limit(500);
      if (error) throw error;

      const ids = (data ?? []).map((r: { id: string }) => r.id);
      if (ids.length === 0) break;

      const { error: upErr } = await supabase
        .from('email_send_log')
        .update({ content_html: null })
        .in('id', ids);
      if (upErr) throw upErr;

      total += ids.length;
      if (ids.length < 500) break;
    }
    if (total) console.log(`[bulk-emailing] pruned content_html from ${total} rows older than ${days}d`);
    return { pruned: total };
  } catch (err) {
    console.error('[bulk-emailing] prune content_html failed:', err);
    return { error: (err as Error).message };
  }
}
