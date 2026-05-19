/**
 * tasks:email-digest-sender (spec §12.2).
 *
 * Cron at 09:00 daily and Monday 09:00 weekly. Queries pending
 * notifications by user, groups by task, sends a digest email via
 * the platform's email pipeline, then marks emailed_at.
 *
 * The platform's email-send function is consumed via lazy require;
 * the worker degrades to console.warn when unavailable (dev mode).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function runOnce(supabase: SupabaseClient, cadence: 'daily' | 'weekly'): Promise<{ sent: number }> {
  const since = new Date(Date.now() - (cadence === 'daily' ? 24 : 24 * 7) * 3600_000).toISOString();
  const { data: prefs } = await supabase
    .from('task_user_prefs')
    .select('admin_profile_id, email_enabled, email_cadence')
    .eq('email_enabled', true)
    .eq('email_cadence', cadence);

  let sent = 0;
  for (const user of prefs ?? []) {
    const { data: notifs } = await supabase
      .from('task_notifications')
      .select('id, task_id, kind, payload, created_at')
      .eq('recipient_id', user.admin_profile_id)
      .gte('created_at', since)
      .is('emailed_at', null)
      .order('created_at', { ascending: false });
    if (!notifs?.length) continue;

    // Look up profile email.
    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('id, email, display_name')
      .eq('id', user.admin_profile_id)
      .single();
    if (!profile?.email) continue;

    // Group by task for readable digest.
    const byTask = new Map<string, typeof notifs>();
    for (const n of notifs) {
      const list = byTask.get(n.task_id) ?? [];
      list.push(n);
      byTask.set(n.task_id, list);
    }

    // Fetch task titles in one query.
    const taskIds = [...byTask.keys()];
    const { data: tasks } = await supabase.from('tasks').select('id, title, board_id').in('id', taskIds);
    const titleMap = new Map((tasks ?? []).map(t => [t.id, t.title]));

    const lines: string[] = [];
    for (const [taskId, taskNotifs] of byTask) {
      const title = titleMap.get(taskId) ?? '(unknown task)';
      lines.push(`• ${title}`);
      for (const n of taskNotifs) lines.push(`   - ${friendly(n.kind)}`);
    }
    const subject = cadence === 'daily'
      ? `Your Tasks digest — ${notifs.length} update${notifs.length === 1 ? '' : 's'}`
      : `Weekly Tasks digest — ${notifs.length} update${notifs.length === 1 ? '' : 's'}`;
    const body = lines.join('\n');
    await sendEmail(profile.email, subject, body);
    await supabase
      .from('task_notifications')
      .update({ emailed_at: new Date().toISOString() })
      .in('id', notifs.map(n => n.id));
    sent += 1;
  }
  return { sent };
}

function friendly(kind: string): string {
  switch (kind) {
    case 'assigned': return 'Assigned to you';
    case 'mentioned': return 'You were mentioned';
    case 'comment_on_followed': return 'New comment';
    case 'due_soon': return 'Due soon';
    case 'status_changed_for_followed': return 'Status changed';
    default: return kind;
  }
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // Lazy-require the platform's email pipeline. Falls back to console.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('@gatewaze/shared/email');
    if (mod?.send) {
      await mod.send({ to, subject, body });
      return;
    }
  } catch {
    /* fall through */
  }
  // eslint-disable-next-line no-console
  console.log(`[tasks email-digest] (no email backend) → ${to}: ${subject}\n${body}`);
}
